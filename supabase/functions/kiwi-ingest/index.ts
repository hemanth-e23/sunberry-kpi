// Supabase Edge Function: kiwi-ingest
//
// The ONLY way the supervisors' shift report gets into the database. kiwi_sync.py
// (on the PC that syncs the SharePoint folder) posts a parsed workbook here; this
// checks a shared secret, validates every field, and replaces that month's rows
// in one transaction via public.kiwi_replace_month() (service role only).
// The browser never calls this. Same pattern as plc-ingest.
//
// Setup (once):
//   supabase secrets set KIWI_SYNC_TOKEN=<64 random characters, also given to the sync PC>
//   supabase functions deploy kiwi-ingest --no-verify-jwt
//
// --no-verify-jwt is intentional: the sync PC has no Supabase login and shouldn't
// hold a Supabase key. The token replaces that check, and the function refuses
// to run at all if the token isn't set or is short.
//
// Request: POST, header  x-kiwi-token: <token>, JSON body from kiwi_sync.py.

import { validateUpload } from "./validate.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TOKEN = Deno.env.get("KIWI_SYNC_TOKEN") ?? "";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Compare hashes so the time taken doesn't reveal how much of a guess matched.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  // Fail closed: a missing or weak token must never mean "let everyone in".
  if (!SUPABASE_URL || !SERVICE_KEY || TOKEN.length < 32) {
    console.error("kiwi-ingest is not configured (KIWI_SYNC_TOKEN missing or too short)");
    return reply(500, { error: "not configured" });
  }
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  if (!(await sameSecret(req.headers.get("x-kiwi-token") ?? "", TOKEN))) {
    return reply(401, { error: "unauthorized" });
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return reply(413, { error: "too large" });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return reply(413, { error: "too large" });

  let body: unknown;
  try { body = JSON.parse(text); } catch { return reply(400, { error: "body is not JSON" }); }

  const v = validateUpload(body);
  if (!v.ok) return reply(400, { error: v.error });

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/kiwi_replace_month`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p: v.upload }),
  });
  if (!res.ok) {
    console.error("kiwi_replace_month failed", res.status, await res.text());
    return reply(502, { error: "database write failed" });
  }
  const counts = await res.json();
  console.log(JSON.stringify({ kiwi_ingest: v.upload.source_file, month: v.upload.month_start, counts }));
  return reply(200, { saved: counts });
});
