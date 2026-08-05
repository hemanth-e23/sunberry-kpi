// Supabase Edge Function: production-detail
//
// Proxies the inventory backend's /api/kpi/production/detail endpoint so the
// KPI dashboard can show today's per-product breakdown + a time-bucketed
// (hourly / 30-min / 15-min) drill-down WITHOUT exposing the inventory bearer
// token to the browser. Mirrors the auth/plumbing of the existing
// `sync-production` function.
//
// Deploy:  supabase functions deploy production-detail
// Secrets (reuse whatever `sync-production` already has set):
//   supabase secrets set INVENTORY_API_URL=https://<inventory-host>
//   supabase secrets set KPI_API_TOKEN=<same token the inventory /api/kpi/* expects>
//   supabase secrets set KPI_WAREHOUSE_ID=<the Sunberry warehouse id>

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Accept a few env-name variants so this lines up with whatever the existing
// sync-production function already uses.
function pick(...names: string[]): string | undefined {
  for (const n of names) {
    const v = Deno.env.get(n);
    if (v) return v;
  }
  return undefined;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  const base = pick("INVENTORY_API_URL", "KPI_INVENTORY_URL", "INVENTORY_BASE_URL");
  const token = pick("KPI_API_TOKEN", "INVENTORY_KPI_TOKEN");
  const envWarehouse = pick("KPI_WAREHOUSE_ID", "WAREHOUSE_ID", "SUNBERRY_WAREHOUSE_ID");

  if (!base || !token) {
    return json({ error: "Function not configured: set INVENTORY_API_URL and KPI_API_TOKEN" }, 503);
  }

  let payload: { date?: string; bucket_minutes?: number; warehouse_id?: string } = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      payload = await req.json();
    }
  } catch {
    // empty / non-JSON body is fine — use defaults
  }

  const warehouseId = payload.warehouse_id || envWarehouse;
  if (!warehouseId) {
    return json({ error: "warehouse_id missing (pass it or set KPI_WAREHOUSE_ID)" }, 400);
  }

  const bucket = [15, 30, 60].includes(Number(payload.bucket_minutes))
    ? Number(payload.bucket_minutes)
    : 30;

  const url = new URL(`${base.replace(/\/$/, "")}/api/kpi/production/detail`);
  url.searchParams.set("warehouse_id", warehouseId);
  url.searchParams.set("bucket_minutes", String(bucket));
  if (payload.date) url.searchParams.set("date", payload.date);

  try {
    const upstream = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
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
