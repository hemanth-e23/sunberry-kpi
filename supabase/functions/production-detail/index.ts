// Supabase Edge Function: production-detail
//
// Proxies the inventory backend's /api/kpi/production/detail endpoint so the
// KPI dashboard can show today's per-product breakdown + a time-bucketed
// (hourly / 30-min / 15-min) drill-down WITHOUT exposing the inventory bearer
// token to the browser. Mirrors the auth/plumbing of the existing
// `sync-production` function.
//
// Deploy:  supabase functions deploy production-detail
// Reuses the SAME secrets as `sync-production` — no new config needed:
//   KPI_API_BASE (default https://inventory-api.sunberryfarms.net)
//   KPI_API_TOKEN
//   KPI_WAREHOUSE_ID (default MP-01)

const API_BASE = Deno.env.get("KPI_API_BASE") ?? "https://inventory-api.sunberryfarms.net";
const API_TOKEN = Deno.env.get("KPI_API_TOKEN")!;
const WAREHOUSE = Deno.env.get("KPI_WAREHOUSE_ID") ?? "MP-01";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Signed-in users only. Supabase's own JWT check also accepts the public anon
// key (it is a valid JWT and it ships in the website), so on its own it would
// let anyone pull production data. Asking Auth for the user closes that.
async function signedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+/.test(auth) || !SUPABASE_URL || !ANON_KEY) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: auth } });
    if (!r.ok) return false;
    const u = await r.json();
    return typeof u?.id === "string" && u.id.length > 0;
  } catch {
    return false;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (!(await signedIn(req))) return json({ error: "Please sign in again." }, 401);

  let payload: { date?: string; bucket_minutes?: number; warehouse_id?: string; start?: string; end?: string } = {};
  try {
    payload = await req.json();
  } catch {
    // empty / non-JSON body is fine — use defaults
  }

  const warehouseId = payload.warehouse_id || WAREHOUSE;
  const base = `${API_BASE.replace(/\/$/, "")}/api/kpi/production`;

  // Two modes: { start, end } → per-day range; otherwise → single-day detail.
  let url: URL;
  if (payload.start && payload.end) {
    url = new URL(`${base}/range`);
    url.searchParams.set("warehouse_id", warehouseId);
    url.searchParams.set("start", payload.start);
    url.searchParams.set("end", payload.end);
  } else {
    const bucket = [15, 30, 60].includes(Number(payload.bucket_minutes)) ? Number(payload.bucket_minutes) : 30;
    url = new URL(`${base}/detail`);
    url.searchParams.set("warehouse_id", warehouseId);
    url.searchParams.set("bucket_minutes", String(bucket));
    if (payload.date) url.searchParams.set("date", payload.date);
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return json({ error: `Inventory ${upstream.status}: ${text.slice(0, 300)}` }, upstream.status);
    }
    return new Response(text, {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json({ error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
});
