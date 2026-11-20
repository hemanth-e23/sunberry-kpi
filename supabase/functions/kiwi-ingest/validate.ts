// kiwi-ingest - check every field of an uploaded shift report before it reaches
// the database. Anything unexpected rejects the whole upload, so the sync PC
// keeps the file and logs why, instead of rows silently going missing.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

export const LIMITS = { production: 2000, downtime: 4000, people: 2000, notes: 200 };

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

export type Upload = {
  month_start: string; month_end: string; source_file: string; warnings: string;
  production: unknown[]; downtime: unknown[]; people: unknown[]; notes: unknown[];
};

export function validateUpload(body: unknown): { ok: true; upload: Upload } | { ok: false; error: string } {
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
