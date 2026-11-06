// Supabase Edge Function: plc-ingest
//
// The ONLY way data from the plant PC gets into Supabase. tank_sync.py on the
// plant PC posts sugar & syrup room tank levels here; this checks a shared
// secret, validates every value, and writes with the service role. The browser
// never calls this and cannot write those tables itself.
//
// Setup (once):
//   supabase secrets set PLC_INGEST_TOKEN=<the token generated for the plant PC>
//   supabase functions deploy plc-ingest --no-verify-jwt
//
// --no-verify-jwt is intentional: the plant PC has no Supabase login, and giving
// it one would mean handing it a Supabase key. The shared token below replaces
// that check, and the function refuses to run at all if the token isn't set.
//
// Request:  POST, header  x-plc-token: <token>
//   {
//     "readings":  [{ "tank": "CT1", "ts": "2026-11-06T09:30:00-05:00",
//                     "gallons": 3493.1, "inches": 60.0 }, ...],
//     "heartbeat": { "last_reading": "<iso ts>", "levels": { "CT1": 3493.1, ... } }
//   }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INGEST_TOKEN = Deno.env.get("PLC_INGEST_TOKEN") ?? "";

// Must match the check constraint in supabase_tank_readings.sql.
const CAPACITY: Record<string, number> = {
  "CT1": 5500,
  "CT2": 5500,
  "SR tank 1": 6000,
  "SR tank 2": 8000,
  "SR tank 3": 6000,
};

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ROWS = 1000;
const MAX_AGE_MS = 35 * 24 * 3600 * 1000;   // backfill after a long outage
const MAX_AHEAD_MS = 10 * 60 * 1000;         // plant PC clock may run a bit fast

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

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

function validTs(v: unknown): string | null {
  // Require an explicit offset so a timezone mistake can't shift every reading.
  if (typeof v !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(v)) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const now = Date.now();
  if (t < now - MAX_AGE_MS || t > now + MAX_AHEAD_MS) return null;
  return new Date(t).toISOString();
}

const validGallons = (tank: string, g: unknown) =>
  typeof g === "number" && Number.isFinite(g) && g >= -500 && g <= CAPACITY[tank] * 1.3;

const validInches = (i: unknown) =>
  i === null || i === undefined ||
  (typeof i === "number" && Number.isFinite(i) && i >= -10 && i <= 400);

async function rest(path: string, prefer: string, rows: unknown) {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(rows),
  });
}

Deno.serve(async (req) => {
  // Fail closed: a missing or weak token must never mean "let everyone in".
  if (!SUPABASE_URL || !SERVICE_KEY || INGEST_TOKEN.length < 32) {
    console.error("plc-ingest is not configured (PLC_INGEST_TOKEN missing or too short)");
    return reply(500, { error: "not configured" });
  }
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const given = req.headers.get("x-plc-token") ?? "";
  if (!(await sameSecret(given, INGEST_TOKEN))) return reply(401, { error: "unauthorized" });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return reply(413, { error: "too large" });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return reply(413, { error: "too large" });

  let body: { readings?: unknown; heartbeat?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: "body is not JSON" });
  }

  // --- readings ------------------------------------------------------------
  const raw = Array.isArray(body.readings) ? body.readings : [];
  if (raw.length > MAX_ROWS) return reply(413, { error: `at most ${MAX_ROWS} readings per request` });

  const rows = [];
  for (const r of raw as Record<string, unknown>[]) {
    const tank = typeof r?.tank === "string" ? r.tank : "";
    const ts = validTs(r?.ts);
    if (!(tank in CAPACITY) || !ts || !validGallons(tank, r.gallons) || !validInches(r.inches)) {
      // Reject the whole batch: the plant PC keeps it and retries, and the
      // reason shows in its log instead of rows silently going missing.
      return reply(400, { error: "invalid reading", reading: r });
    }
    rows.push({ tank, ts, gallons: r.gallons, inches: r.inches ?? null });
  }

  if (rows.length) {
    const res = await rest("tank_readings?on_conflict=tank,ts",
      "resolution=ignore-duplicates,return=minimal", rows);
    if (!res.ok) {
      console.error("tank_readings insert failed", res.status, await res.text());
      return reply(502, { error: "database write failed" });
    }
  }

  // --- heartbeat -----------------------------------------------------------
  const hb = body.heartbeat as Record<string, unknown> | undefined;
  if (hb && typeof hb === "object") {
    const levels: Record<string, number> = {};
    const sent = (hb.levels && typeof hb.levels === "object") ? hb.levels as Record<string, unknown> : {};
    for (const [tank, g] of Object.entries(sent)) {
      if (tank in CAPACITY && validGallons(tank, g)) levels[tank] = g as number;
    }
    const res = await rest("plc_heartbeat?on_conflict=source",
      "resolution=merge-duplicates,return=minimal", [{
        source: "plant-pc",
        last_seen: new Date().toISOString(),   // server clock, not the plant PC's
        last_reading: validTs(hb.last_reading),
        levels,
      }]);
    if (!res.ok) {
      console.error("plc_heartbeat upsert failed", res.status, await res.text());
      return reply(502, { error: "database write failed" });
    }
  }

  return reply(200, { saved: rows.length, heartbeat: !!hb });
});
