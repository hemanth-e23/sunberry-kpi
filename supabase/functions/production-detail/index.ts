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

  let payload: { date?: string; bucket_minutes?: number; warehouse_id?: string } = {};
  try {
    payload = await req.json();
  } catch {
    // empty / non-JSON body is fine — use defaults
  }

  const warehouseId = payload.warehouse_id || WAREHOUSE;
  const bucket = [15, 30, 60].includes(Number(payload.bucket_minutes))
    ? Number(payload.bucket_minutes)
    : 30;

  const url = new URL(`${API_BASE.replace(/\/$/, "")}/api/kpi/production/detail`);
  url.searchParams.set("warehouse_id", warehouseId);
  url.searchParams.set("bucket_minutes", String(bucket));
  if (payload.date) url.searchParams.set("date", payload.date);

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
