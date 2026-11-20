// Supabase Edge Function: kiwi
//
// KIWI answers staff questions about production. Flow per question:
//   signed-in KPI user -> this function -> AI writes a SELECT -> run it as the
//   read-only kiwi_reader login -> AI turns the result into a short answer.
// The browser only ever receives the final answer text. The database password
// and the AI key stay here as Supabase secrets.
//
// Deploy:  supabase functions deploy kiwi
// Secrets (supabase secrets set NAME=value):
//   ANTHROPIC_API_KEY   - AI key
//   KIWI_DB_URL         - connection string for the kiwi_reader login (see README)
//   KIWI_MANAGER_DB_URL - connection string for kiwi_manager_reader (can see absence names)
//   KIWI_MODEL          - optional, default claude-sonnet-5-5
//   KIWI_PEOPLE_ROLES   - optional, roles allowed to see absence names, default "manager"
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase automatically.

import postgres from "npm:postgres@3.4.5";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { guardSql, MAX_ROWS } from "./sql_guard.ts";
import { questionContext, systemPrompt } from "./prompt.ts";

const AI_URL = Deno.env.get("KIWI_AI_URL") ?? "https://api.anthropic.com/v1/messages";
const MODEL = Deno.env.get("KIWI_MODEL") ?? "claude-sonnet-5-5";
const PEOPLE_ROLES = (Deno.env.get("KIWI_PEOPLE_ROLES") ?? "manager").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_ROUNDS = 8;          // query attempts per question
const MAX_RESULT_CHARS = 20000; // rows sent back to the AI per query
const TZ = "America/Detroit";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// One small pool per login per function instance. prepare:false is required by
// the Supabase transaction pooler (port 6543).
const pools = new Map<string, ReturnType<typeof postgres>>();
function getDb(manager: boolean) {
  const key = manager ? "KIWI_MANAGER_DB_URL" : "KIWI_DB_URL";
  if (!pools.has(key)) {
    const url = Deno.env.get(key);
    if (!url) throw new Error(`${key} is not set`);
    pools.set(key, postgres(url, { max: 2, prepare: false, idle_timeout: 20 }));
  }
  return pools.get(key)!;
}

const TOOLS = [{
  name: "run_sql",
  description: "Run one read-only PostgreSQL SELECT against the kiwi views and get the rows back as JSON " +
    "(at most 200 rows). Use aggregates to keep results small.",
  input_schema: {
    type: "object",
    properties: { sql: { type: "string", description: "A single SELECT (or WITH ... SELECT) statement." } },
    required: ["sql"],
  },
}];

type Block = { type: string; text?: string; id?: string; name?: string; input?: { sql?: string } };
type Msg = { role: "user" | "assistant"; content: string | unknown[] };

export async function runQuery(sql: string, allowPeople: boolean): Promise<string> {
  const g = guardSql(sql, { allowPeople });
  if (!g.ok) return JSON.stringify({ error: g.error });
  try {
    // Managers use a login that can see absence names; everyone else uses one
    // that the database itself won't let see them.
    const rows = await getDb(allowPeople).begin("read only", async (tx) => {
      await tx.unsafe("set local statement_timeout = '8s'");
      // One parameter (the row cap) = Postgres's one-statement protocol.
      return await tx.unsafe(g.sql, [MAX_ROWS]);
    });
    let out = JSON.stringify({ row_count: rows.length, rows });
    if (out.length > MAX_RESULT_CHARS) {
      out = out.slice(0, MAX_RESULT_CHARS) + '..."(truncated: aggregate or filter more)"';
    }
    return out;
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
const STATIC_PROMPT = systemPrompt();

async function callAI(context: string, messages: Msg[]) {
  // The big unchanging instructions are marked cacheable; the per-question
  // context (date, role) comes after so it doesn't break the cache.
  const system = [
    { type: "text", text: STATIC_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: context },
  ];
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, tools: TOOLS, messages }),
  });
  if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json() as { content: Block[]; stop_reason: string; usage?: Usage };
}

export async function answer(question: string, history: { role: string; text: string }[], user: { role: string; label: string }) {
  const allowPeople = PEOPLE_ROLES.includes(user.role);
  const now = new Date();
  const context = questionContext({
    now: now.toLocaleString("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    today: now.toLocaleDateString("en-CA", { timeZone: TZ }), // YYYY-MM-DD
    userRole: user.role,
    allowPeople,
  });

  // Earlier turns as plain text only (no old query results), newest last.
  const messages: Msg[] = [];
  for (const h of history.slice(-10)) {
    const role = h.role === "assistant" ? "assistant" : "user";
    const text = String(h.text ?? "").slice(0, 4000);
    if (!text) continue;
    if (messages.length && messages[messages.length - 1].role === role) continue; // keep turns alternating
    messages.push({ role, content: text });
  }
  if (messages.length && messages[0].role !== "user") messages.shift();
  if (messages.length && messages[messages.length - 1].role === "user") messages.pop();
  messages.push({ role: "user", content: question });

  const used = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, rounds: 0 };
  const done = (text: string, why: string) => {
    console.log(JSON.stringify({ kiwi: "usage", user: user.label, why, ...used }));
    return text;
  };
  let nudged = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await callAI(context, messages);
    used.rounds++;
    used.in += r.usage?.input_tokens ?? 0;
    used.out += r.usage?.output_tokens ?? 0;
    used.cacheRead += r.usage?.cache_read_input_tokens ?? 0;
    used.cacheWrite += r.usage?.cache_creation_input_tokens ?? 0;
    const toolUses = r.content.filter((b) => b.type === "tool_use");
    if (r.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) return done(text, r.stop_reason);
      // No text came back (e.g. ran out of room mid-reply). Ask once more for a plain answer.
      console.warn(JSON.stringify({ kiwi: "empty_reply", stop_reason: r.stop_reason, round }));
      if (nudged) break;
      nudged = true;
      if (r.content.length) messages.push({ role: "assistant", content: r.content });
      messages.push({ role: "user", content: "Please give your answer now in plain words, based on what you found. " +
        "If the data isn't available, say what's missing and what you can tell instead." });
      continue;
    }
    messages.push({ role: "assistant", content: r.content });
    const results = [];
    for (const t of toolUses) {
      const sql = String(t.input?.sql ?? "");
      const out = await runQuery(sql, allowPeople);
      console.log(JSON.stringify({ kiwi: "query", user: user.label, sql: sql.slice(0, 2000), ok: !out.startsWith('{"error"') }));
      results.push({ type: "tool_result", tool_use_id: t.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }
  return done("Sorry, I couldn't finish that one. Try narrowing it (a date, a line, or a product).", "gave_up");
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Only signed-in KPI users. (The public anon key alone is NOT enough.)
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: u } = await sb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!u?.user) return json({ error: "Please sign in again." }, 401);
  const { data: profile } = await sb.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
  // Accounts made by the plant (with a profile) only - not someone who signed
  // themselves up through the public Auth API.
  if (!profile) return json({ error: "Your account isn't set up for KIWI. Ask the KPI admin." }, 403);

  let body: { question?: string; history?: { role: string; text: string }[] };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const question = String(body.question ?? "").trim().slice(0, 1000);
  if (!question) return json({ error: "Ask a question." }, 400);

  try {
    const text = await answer(question, Array.isArray(body.history) ? body.history : [],
      { role: profile.role ?? "", label: u.user.email ?? u.user.id });
    console.log(JSON.stringify({ kiwi: "answer", user: u.user.email, question }));
    return json({ answer: text });
  } catch (e) {
    console.error("kiwi failed", e);
    return json({ error: "KIWI is having trouble right now. Please try again in a minute." }, 502);
  }
});
