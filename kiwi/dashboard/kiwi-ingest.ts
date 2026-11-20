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
//   Supabase dashboard -> Edge Functions -> new function "kiwi-ingest", JWT verification OFF
//
// --no-verify-jwt is intentional: the sync PC has no Supabase login and shouldn't
// hold a Supabase key. The token replaces that check, and the function refuses
// to run at all if the token isn't set or is short.
//
// Request: POST, header  x-kiwi-token: <token>, JSON body from kiwi_sync.py.

// ===== field checks =====
// kiwi-ingest - check every field of an uploaded shift report before it reaches
// the database. Anything unexpected rejects the whole upload, so the sync PC
// keeps the file and logs why, instead of rows silently going missing.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

const LIMITS = { production: 2000, downtime: 4000, people: 2000, notes: 200 };

type Spec = Record<string, "date" | "shift" | "line" | "int" | "num" | "time" | ["text", number] | "kind">;

const SPECS: Record<keyof typeof LIMITS, Spec> = {
  production: {
    report_date: "date", shift: "shift", supervisor: ["text", 200], line: "line", sku: ["text", 100],
    product: ["text", 200], lot: ["text", 100], planned_batches: "num", filler_start: "time",
    first_bottle: "time", last_bottle: "time", batches_made: "num", total_gallons: "num",
    cases_produced: "num", pct_loss: "num", cases_reworked: "num", bottles_loaded: "num",
    caps_loaded: "num", bottle_loss: "num", source_file: ["text", 300], sheet: ["text", 50], row_no: "int",
  },
  downtime: {
    report_date: "date", shift: "shift", line: "line", minutes: "num", duration_raw: ["text", 100],
    equipment: ["text", 300], reason: ["text", 2000], source_file: ["text", 300], sheet: ["text", 50], row_no: "int",
  },
  people: {
    report_date: "date", shift: "shift", kind: "kind", name: ["text", 200],
    source_file: ["text", 300], sheet: ["text", 50], row_no: "int",
  },
  notes: {
    report_date: "date", shift: "shift", important_info: ["text", 20000], supervisor_notes: ["text", 20000],
    source_file: ["text", 300], sheet: ["text", 50],
  },
};

function check(kind: Spec[string], v: unknown): boolean {
  if (v === null || v === undefined) return kind !== "date" && kind !== "shift" && kind !== "kind";
  switch (kind) {
    case "date": return typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));
    case "time": return typeof v === "string" && TIME.test(v);
    case "shift": return v === 1 || v === 2;
    case "line": return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9;
    case "int": return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e6;
    case "num": return typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e9;
    case "kind": return v === "absence" || v === "part_day";
    default: return typeof v === "string" && v.length <= kind[1];
  }
}

type Upload = {
  month_start: string; month_end: string; source_file: string; warnings: string;
  production: unknown[]; downtime: unknown[]; people: unknown[]; notes: unknown[];
};

function validateUpload(body: unknown): { ok: true; upload: Upload } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (!check("date", b.month_start) || !check("date", b.month_end)) return { ok: false, error: "bad month_start/month_end" };
  const ms = String(b.month_start), me = String(b.month_end);
  if (!ms.endsWith("-01")) return { ok: false, error: "month_start must be the 1st" };
  const end = new Date(Date.UTC(Number(ms.slice(0, 4)), Number(ms.slice(5, 7)), 0)).toISOString().slice(0, 10);
  if (me !== end) return { ok: false, error: "month_end must be the last day of that month" };

  const out: Record<string, unknown[]> = {};
  for (const table of Object.keys(SPECS) as (keyof typeof LIMITS)[]) {
    const rows = b[table] ?? [];
    if (!Array.isArray(rows)) return { ok: false, error: `${table} must be a list` };
    if (rows.length > LIMITS[table]) return { ok: false, error: `too many ${table} rows` };
    const spec = SPECS[table];
    const clean = [];
    for (const [i, r] of rows.entries()) {
      if (!r || typeof r !== "object") return { ok: false, error: `${table}[${i}] is not an object` };
      const row: Record<string, unknown> = {};
      for (const [k, kind] of Object.entries(spec)) {
        const v = (r as Record<string, unknown>)[k];
        if (!check(kind, v)) return { ok: false, error: `${table}[${i}].${k} is invalid` };
        row[k] = v ?? null;
      }
      const d = row.report_date as string;
      if (d < ms || d > me) return { ok: false, error: `${table}[${i}].report_date is outside the month` };
      clean.push(row);  // only known fields go through
    }
    out[table] = clean;
  }
  const source_file = typeof b.source_file === "string" ? b.source_file.slice(0, 300) : "";
  const warnings = typeof b.warnings === "string" ? b.warnings.slice(0, 5000) : "";
  return { ok: true, upload: { month_start: ms, month_end: me, source_file, warnings, ...out } as Upload };
}

// ===== function =====
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
