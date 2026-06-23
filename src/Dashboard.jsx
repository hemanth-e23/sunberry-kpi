import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./lib/supabase";
import CommentsModal, { CommentsList } from "./Comments.jsx";

const DEFAULT_FILLER_TARGET = "05:30";

const trimTime = (t) => (t ? t.slice(0, 5) : null);

function rowToEntry(r) {
  return {
    date: r.entry_date,
    product: r.product,
    line1_produced: r.line1_produced,
    line1_target: r.line1_target,
    line1_capacity: r.line1_capacity,
    line1_filler_start: trimTime(r.line1_filler_start),
    line1_filler_target: trimTime(r.line1_filler_target),
    line2_produced: r.line2_produced,
    line2_target: r.line2_target,
    line2_capacity: r.line2_capacity,
    line2_filler_start: trimTime(r.line2_filler_start),
    line2_filler_target: trimTime(r.line2_filler_target),
    notes: r.notes,
    // live-sync provenance
    line1_produced_synced: r.line1_produced_synced,
    line2_produced_synced: r.line2_produced_synced,
    line1_produced_manual: r.line1_produced_manual,
    line2_produced_manual: r.line2_produced_manual,
    line1_filler_start_synced: trimTime(r.line1_filler_start_synced),
    line2_filler_start_synced: trimTime(r.line2_filler_start_synced),
    last_synced_at: r.last_synced_at,
  };
}

function entryToRow(e) {
  return {
    entry_date: e.date,
    product: e.product,
    line1_produced: e.line1_produced,
    line1_target: e.line1_target,
    line1_capacity: e.line1_capacity,
    line1_filler_start: e.line1_filler_start || null,
    line1_filler_target: e.line1_filler_target || null,
    line2_produced: e.line2_produced,
    line2_target: e.line2_target,
    line2_capacity: e.line2_capacity,
    line2_filler_start: e.line2_filler_start || null,
    line2_filler_target: e.line2_filler_target || null,
    notes: e.notes || null,
    // who owns each field: a hand-saved value wins over the live sync
    line1_produced_manual: e.line1_produced_manual,
    line2_produced_manual: e.line2_produced_manual,
    line1_filler_start_manual: e.line1_filler_start_manual,
    line2_filler_start_manual: e.line2_filler_start_manual,
  };
}

function getWeekNumber(d) {
  const date = new Date(d); date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return Math.round(((date - week1) / 86400000 + week1.getDay() + 1) / 7);
}
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Production day runs 05:30 → 05:30 (matches the inventory/scanner production
// day the synced numbers are filed under). Before 05:30 local, "today" is still
// the previous calendar date, so overnight the UI and the counted numbers agree.
const PRODUCTION_DAY_START_MIN = 5 * 60 + 30; // 05:30
function productionDateStr(d) {
  const base = new Date(d);
  if (base.getHours() * 60 + base.getMinutes() < PRODUCTION_DAY_START_MIN) {
    base.setDate(base.getDate() - 1);
  }
  return localDateStr(base);
}

// Effective defaults for a given production date: the latest production_targets
// row whose effective_from is on/before that date. `targets` ascending by date.
// This is what makes target changes apply from today forward without disturbing
// past days — each day resolves to whatever was in effect then.
function effectiveTargets(dateStr, targets) {
  let chosen = null;
  for (const t of targets || []) {
    if (t.effective_from <= dateStr) chosen = t; else break;
  }
  return chosen;
}
function workingDaysInMonth(year, month) {
  const last = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let day = 1; day <= last; day++) {
    const dow = new Date(year, month, day).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}
function workingDaysRemaining(year, month, fromDay) {
  const last = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let day = fromDay; day <= last; day++) {
    const dow = new Date(year, month, day).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}
function getMonday(d) {
  const date = new Date(d); const day = date.getDay();
  date.setDate(date.getDate() - day + (day === 0 ? -6 : 1)); date.setHours(0, 0, 0, 0); return date;
}
function formatDate(d) { return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
function formatDay(d) { return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); }
function formatDayShort(d) { return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); }
function fmt(n) { return n?.toLocaleString() ?? "—"; }
function pc(a, b) { return b > 0 ? ((a / b) * 100).toFixed(1) : "—"; }
function timeToMinutes(t) { if (!t) return null; const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function minutesDiff(actual, target) { const a = timeToMinutes(actual), t = timeToMinutes(target); if (a === null || t === null) return null; return a - t; }
function formatMinDiff(diff) {
  if (diff === null) return "—"; if (diff === 0) return "On time";
  const abs = Math.abs(diff), h = Math.floor(abs / 60), m = abs % 60;
  const ts = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return diff > 0 ? `+${ts} late` : `${ts} early`;
}
function formatTime12(t) { if (!t) return "—"; const [h, m] = t.split(":"); const hr = parseInt(h); return `${hr > 12 ? hr - 12 : hr || 12}:${m} ${hr >= 12 ? "PM" : "AM"}`; }
function pctChange(c, p) { return (!p || p === 0) ? null : ((c - p) / p) * 100; }
function eTotal(e) { return e ? (e.line1_produced || 0) + (e.line2_produced || 0) : 0; }
function eTarget(e) { return e ? (e.line1_target || 0) + (e.line2_target || 0) : 0; }
function eCap(e) { return e ? (e.line1_capacity || 0) + (e.line2_capacity || 0) : 0; }
function eEff(e) { if (!e) return null; const t = eTarget(e); return t > 0 ? (eTotal(e) / t) * 100 : null; }
function aggEff(arr) { if (!arr || arr.length === 0) return null; const p = arr.reduce((s, e) => s + eTotal(e), 0); const t = arr.reduce((s, e) => s + eTarget(e), 0); return t > 0 ? (p / t) * 100 : null; }
function ppDelta(a, b) { return (a == null || b == null) ? null : a - b; }
function uniqueProducts(arr) { return [...new Set((arr || []).map(e => e.product).filter(Boolean))]; }
function perfColor(tgtHitPct) {
  if (tgtHitPct == null) return "rgba(44,36,22,0.6)";
  if (tgtHitPct >= 90) return "#0E9990";
  if (tgtHitPct >= 75) return "#C4920F";
  return "#D94A42";
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// --- Theme colors ---
const T = {
  bg: "#F5F0E8", card: "rgba(255,255,255,0.6)", border: "rgba(0,0,0,0.06)", borderStrong: "rgba(0,0,0,0.1)",
  text: "#2C2416", textMid: "rgba(44,36,22,0.6)", textLight: "rgba(44,36,22,0.4)", textFaint: "rgba(44,36,22,0.2)",
  teal: "#0E9990", coral: "#D94A42", gold: "#C4920F", purple: "#7054AD",
  tealBg: "rgba(14,153,144,0.1)", coralBg: "rgba(217,74,66,0.07)", goldBg: "rgba(196,146,15,0.1)",
  gaugeBg: "rgba(0,0,0,0.06)", gaugeInnerBg: "rgba(0,0,0,0.03)",
  barBg: "rgba(0,0,0,0.05)", barBgFaint: "rgba(0,0,0,0.02)",
  modalBg: "#FAF6EF", modalOverlay: "rgba(44,36,22,0.35)",
  inputBg: "rgba(0,0,0,0.03)", inputBorder: "rgba(0,0,0,0.1)",
  footerBg: "#F5F0E8",
  tickerBg: "linear-gradient(90deg, rgba(14,165,160,0.05), rgba(232,82,74,0.03), rgba(14,165,160,0.05))",
};

function ChangeIndicator({ value, suffix = "" }) {
  if (value === null || value === undefined || isNaN(value)) return <span style={{ color: T.textFaint, fontSize: 11 }}>—</span>;
  const color = value > 0 ? T.teal : value < 0 ? T.coral : T.textLight;
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "—";
  return <span style={{ color, fontSize: 11, fontFamily: "var(--mono)", fontWeight: 600 }}>{arrow} {Math.abs(value).toFixed(1)}{suffix}</span>;
}

function SkuTag({ kind }) {
  return (
    <span title={kind === "different" ? "Comparing two days that ran different products — raw cases aren't directly comparable" : "This window mixes multiple products — raw cases aren't directly comparable"}
      style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: T.gold, background: T.goldBg, padding: "2px 5px", borderRadius: 3, fontFamily: "var(--mono)", fontWeight: 600, whiteSpace: "nowrap" }}>
      {kind === "different" ? "Diff SKU" : "Mixed SKUs"}
    </span>
  );
}

function DualGauge({ produced, target, capacity, label, colorA, size = 115 }) {
  const tPct = target > 0 ? Math.min(produced / target, 1) : 0;
  const cPct = capacity > 0 ? Math.min(produced / capacity, 1) : 0;
  const r1 = (size - 16) / 2, r2 = r1 - 14, circ1 = Math.PI * r1, circ2 = Math.PI * r2, cy = size / 2 + 4;
  const innerStroke = "rgba(44,36,22,0.55)";
  return (
    <div style={{ textAlign: "center" }}>
      <svg width={size} height={size / 2 + 24} viewBox={`0 0 ${size} ${size / 2 + 24}`}>
        <path d={`M 8,${cy} A ${r1},${r1} 0 0 1 ${size - 8},${cy}`} fill="none" stroke={T.gaugeBg} strokeWidth="8" strokeLinecap="round" />
        <path d={`M 8,${cy} A ${r1},${r1} 0 0 1 ${size - 8},${cy}`} fill="none" stroke={colorA} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={circ1} strokeDashoffset={circ1 - cPct * circ1} style={{ transition: "stroke-dashoffset 1.2s ease" }} />
        <path d={`M ${8 + 14},${cy} A ${r2},${r2} 0 0 1 ${size - 8 - 14},${cy}`} fill="none" stroke={T.gaugeInnerBg} strokeWidth="6" strokeLinecap="round" />
        <path d={`M ${8 + 14},${cy} A ${r2},${r2} 0 0 1 ${size - 8 - 14},${cy}`} fill="none" stroke={innerStroke} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={circ2} strokeDashoffset={circ2 - tPct * circ2} style={{ transition: "stroke-dashoffset 1.2s ease" }} />
        <text x={size / 2} y={cy - 6} textAnchor="middle" fill={T.text} fontSize="22" fontWeight="700" fontFamily="var(--mono)">{(cPct * 100).toFixed(1)}%</text>
      </svg>
      <div style={{ display: "flex", justifyContent: "center", gap: 12, fontFamily: "var(--mono)", marginTop: -2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ display: "inline-block", width: 10, height: 3, background: colorA, borderRadius: 2 }} />
          <span style={{ fontSize: 11, color: T.text, fontWeight: 700 }}>{(cPct * 100).toFixed(1)}%</span>
          <span style={{ fontSize: 9, color: T.textMid, letterSpacing: 1, textTransform: "uppercase" }}>cap</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ display: "inline-block", width: 10, height: 3, background: innerStroke, borderRadius: 2 }} />
          <span style={{ fontSize: 11, color: T.text, fontWeight: 700 }}>{(tPct * 100).toFixed(1)}%</span>
          <span style={{ fontSize: 9, color: T.textMid, letterSpacing: 1, textTransform: "uppercase" }}>tgt</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: T.text, marginTop: 6, letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "var(--mono)", fontWeight: 700 }}>{label}</div>
    </div>
  );
}

function StatCard({ title, titleDetail, value, sub, accent, change, changeSuffix, tag }) {
  const hasMeta = !!tag || change !== undefined;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5, gap: "4px 8px" }}>
        <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)", minWidth: 0, flex: "1 1 auto" }}>
          {title}
          {titleDetail && <span style={{ color: T.text, marginLeft: 6, fontSize: 11, textTransform: "none", fontWeight: 600, whiteSpace: "nowrap" }}>{titleDetail}</span>}
        </div>
        {hasMeta && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, flexWrap: "wrap" }}>
            {tag}
            {change !== undefined && <ChangeIndicator value={change} suffix={changeSuffix || "%"} />}
          </div>
        )}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: accent || T.text, fontFamily: "var(--mono)", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: T.textLight, marginTop: 5, lineHeight: 1.4, whiteSpace: "pre-line" }}>{sub}</div>}
    </div>
  );
}

function MonthlyProgressCard({ monthEntries, now, isManager }) {
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [targets, setTargets] = useState({ line1: 0, line2: 0 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ line1: 0, line2: 0 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("monthly_targets")
        .select("line1_target, line2_target")
        .eq("month", monthKey)
        .maybeSingle();
      if (cancelled) return;
      if (error) { console.error("monthly_targets fetch failed", error); return; }
      const next = { line1: data?.line1_target || 0, line2: data?.line2_target || 0 };
      setTargets(next);
      setDraft(next);
    })();
    return () => { cancelled = true; };
  }, [monthKey]);

  const saveTargets = async () => {
    setSaving(true);
    const payload = {
      month: monthKey,
      line1_target: parseInt(draft.line1) || 0,
      line2_target: parseInt(draft.line2) || 0,
    };
    const { data, error } = await supabase
      .from("monthly_targets")
      .upsert(payload, { onConflict: "month" })
      .select()
      .single();
    setSaving(false);
    if (error || !data) {
      alert("Could not save monthly target: " + (error?.message || "no row returned"));
      return;
    }
    setTargets({ line1: data.line1_target, line2: data.line2_target });
    setEditing(false);
  };

  const l1Produced = monthEntries.reduce((s, e) => s + (e.line1_produced || 0), 0);
  const l2Produced = monthEntries.reduce((s, e) => s + (e.line2_produced || 0), 0);
  const totalProduced = l1Produced + l2Produced;
  const totalTarget = (targets.line1 || 0) + (targets.line2 || 0);

  const today = now.getDate();
  const totalWD = workingDaysInMonth(now.getFullYear(), now.getMonth());
  const remainingWD = workingDaysRemaining(now.getFullYear(), now.getMonth(), today + 1);
  const elapsedWD = Math.max(totalWD - remainingWD, 1);
  const daysWithData = monthEntries.length;

  const dailyL1 = daysWithData > 0 ? l1Produced / daysWithData : 0;
  const dailyL2 = daysWithData > 0 ? l2Produced / daysWithData : 0;
  const projectedL1 = l1Produced + dailyL1 * remainingWD;
  const projectedL2 = l2Produced + dailyL2 * remainingWD;

  const requiredL1 = remainingWD > 0 ? Math.max(0, (targets.line1 - l1Produced) / remainingWD) : 0;
  const requiredL2 = remainingWD > 0 ? Math.max(0, (targets.line2 - l2Produced) / remainingWD) : 0;

  const Bar = ({ produced, target, color, label }) => {
    const pct = target > 0 ? Math.min((produced / target) * 100, 100) : 0;
    const pctRaw = target > 0 ? (produced / target) * 100 : 0;
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: "var(--mono)", marginBottom: 3 }}>
          <span style={{ color, fontWeight: 700 }}>{label}</span>
          <span style={{ color: T.text, fontWeight: 600 }}>
            {fmt(produced)}<span style={{ color: T.textMid, fontWeight: 400 }}> / {target > 0 ? fmt(target) : "—"}</span>
            {target > 0 && <span style={{ color: T.textMid, marginLeft: 6 }}>({pctRaw.toFixed(1)}%)</span>}
          </span>
        </div>
        <div style={{ position: "relative", height: 10, background: T.barBg, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: color, transition: "width 0.8s ease" }} />
        </div>
      </div>
    );
  };

  const S = { background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 5, color: T.text, padding: "6px 8px", fontSize: 12, fontFamily: "var(--mono)", width: "100%", boxSizing: "border-box", outline: "none" };
  const L = { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: T.textLight, marginBottom: 3, fontFamily: "var(--mono)" };

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gridColumn: "span 2", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 6 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>
          This Month <span style={{ color: T.textMid, fontWeight: 600, marginLeft: 4, textTransform: "none", letterSpacing: 0 }}>· {now.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
        </div>
        {isManager && !editing && (
          <button onClick={() => setEditing(true)} style={{ background: "transparent", border: `1px solid ${T.borderStrong}`, color: T.teal, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)", textTransform: "uppercase", padding: "3px 8px", borderRadius: 4 }}>Set Target</button>
        )}
      </div>

      {editing ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
            <div><div style={L}>L1 Monthly Tgt</div><input type="number" value={draft.line1} onChange={e => setDraft({ ...draft, line1: e.target.value })} style={S} /></div>
            <div><div style={L}>L2 Monthly Tgt</div><input type="number" value={draft.line2} onChange={e => setDraft({ ...draft, line2: e.target.value })} style={S} /></div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button onClick={() => { setDraft(targets); setEditing(false); }} disabled={saving} style={{ padding: "4px 10px", borderRadius: 5, border: `1px solid ${T.borderStrong}`, background: "transparent", color: T.textMid, fontSize: 10, fontFamily: "var(--mono)", textTransform: "uppercase", cursor: "pointer" }}>Cancel</button>
            <button onClick={saveTargets} disabled={saving} style={{ padding: "4px 10px", borderRadius: 5, border: "none", background: T.teal, color: "#fff", fontSize: 10, fontWeight: 700, fontFamily: "var(--mono)", textTransform: "uppercase", cursor: saving ? "wait" : "pointer" }}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      ) : (
        <>
          <Bar produced={l1Produced} target={targets.line1} color={T.teal} label="LINE I" />
          <Bar produced={l2Produced} target={targets.line2} color={T.coral} label="LINE II" />
          <div style={{ marginTop: 4, paddingTop: 8, borderTop: `1px solid ${T.border}`, fontSize: 11, fontFamily: "var(--mono)" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: T.textMid }}>Combined</span>
              <span style={{ color: T.text, fontWeight: 700 }}>
                {fmt(totalProduced)}<span style={{ color: T.textMid, fontWeight: 400 }}> / {totalTarget > 0 ? fmt(totalTarget) : "—"}</span>
                {totalTarget > 0 && <span style={{ color: T.textMid, marginLeft: 6 }}>({((totalProduced / totalTarget) * 100).toFixed(1)}%)</span>}
              </span>
            </div>
            {totalTarget > 0 && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, color: T.textMid }}>
                  <span>Pace projection</span>
                  <span style={{ color: T.text }}>
                    L1 <span style={{ color: T.teal, fontWeight: 600 }}>{fmt(Math.round(projectedL1))}</span> · L2 <span style={{ color: T.coral, fontWeight: 600 }}>{fmt(Math.round(projectedL2))}</span>
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, color: T.textMid }}>
                  <span>Need per day <span style={{ color: T.textFaint }}>({remainingWD}d left)</span></span>
                  <span style={{ color: T.text }}>
                    L1 <span style={{ color: T.teal, fontWeight: 600 }}>{remainingWD > 0 ? fmt(Math.round(requiredL1)) : "—"}</span> · L2 <span style={{ color: T.coral, fontWeight: 600 }}>{remainingWD > 0 ? fmt(Math.round(requiredL2)) : "—"}</span>
                  </span>
                </div>
              </>
            )}
            {totalTarget === 0 && (
              <div style={{ marginTop: 4, fontSize: 10, color: T.textFaint, fontStyle: "italic" }}>Set monthly target to see progress, pace, and required rate.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MiniBar({ produced, target, capacity, label, color, hasNote }) {
  const scale = Math.max(capacity || 0, target || 0, produced || 0, 1);
  const producedPct = Math.min((produced / scale) * 100, 100);
  const targetPct = Math.min((target / scale) * 100, 100);
  const tgtHitPct = target > 0 ? (produced / target) * 100 : null;
  const capUtilPct = capacity > 0 ? (produced / capacity) * 100 : null;
  const fixN = (n) => (n != null ? n.toFixed(1) : "—");
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: T.text, marginBottom: 5, fontFamily: "var(--mono)", gap: 6 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
          {label}{hasNote && <span style={{ fontSize: 12, opacity: 0.5 }}>💬</span>}
        </span>
        <span style={{ fontSize: 11 }}>
          <span style={{ color: T.text, fontWeight: 700 }}>{fmt(produced)}</span>
          <span style={{ color: T.textMid }}> / {fmt(target)} tgt · {fmt(capacity)} cap</span>
        </span>
      </div>
      <div style={{ position: "relative", height: 14, background: T.barBg, borderRadius: 5, marginTop: 6, marginBottom: 4 }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${producedPct}%`, background: color, borderRadius: 5, transition: "width 0.8s ease" }} />
        {target > 0 && (
          <div title={`Target: ${fmt(target)}`} style={{ position: "absolute", left: `calc(${targetPct}% - 1px)`, top: -4, height: 22, width: 2, background: T.text, borderRadius: 1 }} />
        )}
      </div>
      <div style={{ position: "relative", height: 14, fontSize: 10, fontFamily: "var(--mono)", color: T.textLight, marginTop: 2 }}>
        <span style={{ position: "absolute", left: 0 }}>0</span>
        {target > 0 && (
          <span style={{ position: "absolute", left: `${targetPct}%`, transform: "translateX(-50%)", color: T.text, fontWeight: 700, whiteSpace: "nowrap" }}>↑ tgt</span>
        )}
        <span style={{ position: "absolute", right: 0 }}>cap</span>
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 11, fontFamily: "var(--mono)", color: T.textMid }}>
        <span>Tgt hit: <span style={{ color, fontWeight: 700 }}>{fixN(tgtHitPct)}%</span></span>
        <span>Cap util: <span style={{ color: T.text, fontWeight: 600 }}>{fixN(capUtilPct)}%</span></span>
      </div>
    </div>
  );
}



function NotesPanel({ entries, expanded, onToggle }) {
  const withNotes = [...entries].sort((a, b) => b.date.localeCompare(a.date)).filter(e => e.notes);
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 18 }}>
      <button onClick={onToggle} style={{ width: "100%", padding: "12px 16px", background: "none", border: "none", color: T.text, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
        <span style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>Shift Notes ({withNotes.length})</span>
        <span style={{ fontSize: 14, color: T.textFaint, transition: "transform 0.3s", transform: expanded ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
      </button>
      {expanded && (
        <div style={{ padding: "0 16px 14px", maxHeight: 200, overflowY: "auto" }}>
          {withNotes.length === 0 && <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic", padding: "8px 0" }}>No notes yet</div>}
          {withNotes.map(e => (
            <div key={e.date} style={{ padding: "8px 0", borderBottom: `1px solid ${T.border}`, display: "flex", gap: 12 }}>
              <span style={{ fontSize: 11, color: T.textMid, fontFamily: "var(--mono)", whiteSpace: "nowrap", minWidth: 65 }}>{formatDate(e.date)}</span>
              <span style={{ fontSize: 11, color: T.textLight, lineHeight: 1.4 }}>{e.notes}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MonthComparison({ data }) {
  const available = {};
  data.forEach(e => {
    const d = new Date(e.date + "T12:00:00");
    const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}`;
    const label = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (!available[key]) available[key] = { key, label, entries: [] };
    available[key].entries.push(e);
  });
  const options = Object.values(available).sort((a, b) => b.key.localeCompare(a.key));
  const now = new Date();
  const curKey = `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth()).padStart(2, "0")}`;
  const [monthA, setMonthA] = useState(curKey);
  const [monthB, setMonthB] = useState(prevKey);
  const sum = (arr, k) => arr.reduce((s, e) => s + (e[k] || 0), 0);
  const aE = available[monthA]?.entries || [], bE = available[monthB]?.entries || [];
  const aP = sum(aE, "line1_produced") + sum(aE, "line2_produced"), aT = sum(aE, "line1_target") + sum(aE, "line2_target"), aC = sum(aE, "line1_capacity") + sum(aE, "line2_capacity");
  const bP = sum(bE, "line1_produced") + sum(bE, "line2_produced"), bT = sum(bE, "line1_target") + sum(bE, "line2_target"), bC = sum(bE, "line1_capacity") + sum(bE, "line2_capacity");
  const aEff = aT > 0 ? (aP / aT * 100) : null, bEff = bT > 0 ? (bP / bT * 100) : null;
  const aCU = aC > 0 ? (aP / aC * 100) : null, bCU = bC > 0 ? (bP / bC * 100) : null;
  const fix = (n) => (n != null ? n.toFixed(1) : "—");
  const maxVal = Math.max(aP, bP, aC, bC, 1);

  const selStyle = { background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 5, color: T.text, padding: "5px 8px", fontSize: 11, fontFamily: "var(--mono)", outline: "none", cursor: "pointer" };

  const Bar = ({ val, target, cap, color, label, days, eff, cu }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: T.text, marginBottom: 8, fontFamily: "var(--mono)", fontWeight: 600 }}>{label} <span style={{ color: T.textMid, fontWeight: 400 }}>({days}d)</span></div>
      <div style={{ height: 80, display: "flex", alignItems: "flex-end", marginBottom: 8, position: "relative" }}>
        <div style={{ flex: 1, position: "relative", height: "100%" }}>
          <div title={`Capacity: ${fmt(cap)}`} style={{ height: `${(cap / maxVal) * 100}%`, background: T.barBgFaint, borderRadius: "4px 4px 0 0", position: "absolute", bottom: 0, left: 0, right: 0, border: `1px dashed ${T.borderStrong}` }} />
          <div title={`Produced: ${fmt(val)}`} style={{ height: `${(val / maxVal) * 100}%`, background: color, borderRadius: "4px 4px 0 0", minHeight: val > 0 ? 4 : 0, position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 1, transition: "height 0.8s ease" }} />
          {target > 0 && (
            <div title={`Target: ${fmt(target)}`} style={{ position: "absolute", bottom: `${(target / maxVal) * 100}%`, left: -3, right: -3, height: 2, background: T.text, zIndex: 2 }} />
          )}
        </div>
      </div>
      <div style={{ fontFamily: "var(--mono)" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color }}>{fmt(val)}</div>
        <div style={{ fontSize: 11, color: T.textMid }}>Tgt hit: <span style={{ fontWeight: 600, color: T.text }}>{eff}%</span> · Cap util: <span style={{ fontWeight: 600, color: T.text }}>{cu}%</span></div>
      </div>
    </div>
  );

  const Legend = () => (
    <div style={{ display: "flex", gap: 14, fontSize: 11, fontFamily: "var(--mono)", color: T.textMid, flexWrap: "wrap", marginBottom: 10 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 10, height: 8, background: T.teal, borderRadius: 2 }} /> Produced</span>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 14, height: 2, background: T.text }} /> Target line</span>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 10, height: 8, background: "transparent", border: `1px dashed ${T.borderStrong}`, borderRadius: 2 }} /> Capacity</span>
    </div>
  );

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>Month vs Month</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <select value={monthA} onChange={e => setMonthA(e.target.value)} style={selStyle}>{options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
          <span style={{ fontSize: 12, color: T.textFaint, fontFamily: "var(--mono)" }}>vs</span>
          <select value={monthB} onChange={e => setMonthB(e.target.value)} style={selStyle}>{options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
          {(uniqueProducts(aE).length > 1 || uniqueProducts(bE).length > 1) && <SkuTag kind="mixed" />}
        </div>
      </div>
      {options.length < 1 ? (
        <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic", padding: 10 }}>Need at least 1 month of data</div>
      ) : (
        <>
          <Legend />
          <div style={{ display: "flex", gap: 20 }}>
            <Bar val={aP} target={aT} cap={aC} color={T.teal} label={available[monthA]?.label || monthA} days={aE.length} eff={fix(aEff)} cu={fix(aCU)} />
            <div style={{ width: 1, background: T.border }} />
            <Bar val={bP} target={bT} cap={bC} color={T.textMid} label={available[monthB]?.label || monthB} days={bE.length} eff={fix(bEff)} cu={fix(bCU)} />
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 14, fontSize: 12, fontFamily: "var(--mono)", color: T.textLight, borderTop: `1px solid ${T.border}`, paddingTop: 8, flexWrap: "wrap" }}>
            <span title="Change in % of target hit (plant performance), not a change in the target itself">Tgt hit Δ: <ChangeIndicator value={ppDelta(aEff, bEff)} suffix="pp" /></span>
            <span><span style={{ color: T.teal, fontWeight: 600 }}>{fix(aEff)}%</span> vs <span style={{ fontWeight: 600 }}>{fix(bEff)}%</span></span>
          </div>
        </>
      )}
    </div>
  );
}

function FillerCard({ entries, line }) {
  const recent = [...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const startKey = line === 1 ? "line1_filler_start" : "line2_filler_start";
  const targetKey = line === 1 ? "line1_filler_target" : "line2_filler_target";
  return (
    <div>
      <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, marginBottom: 10, fontFamily: "var(--mono)" }}>
        Line {line === 1 ? "I" : "II"} — Filler Start vs Target
      </div>
      {recent.length === 0 && <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic" }}>No data</div>}
      {recent.map(e => {
        const ft = e[targetKey] || DEFAULT_FILLER_TARGET;
        const diff = minutesDiff(e[startKey], ft);
        const isLate = diff !== null && diff > 0, isOnTime = diff !== null && diff <= 0;
        return (
          <div key={e.date} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${T.border}`, fontSize: 12, fontFamily: "var(--mono)" }}>
            <span style={{ color: T.textMid, minWidth: 55 }}>{formatDate(e.date)}</span>
            <span style={{ color: T.textLight, fontSize: 12 }}>tgt {formatTime12(ft)}</span>
            <span style={{ color: T.textMid }}>{formatTime12(e[startKey])}</span>
            <span style={{ fontWeight: 600, fontSize: 11, padding: "2px 8px", borderRadius: 4, color: isLate ? T.coral : isOnTime ? T.teal : T.textFaint, background: isLate ? T.coralBg : isOnTime ? T.tealBg : "transparent" }}>
              {formatMinDiff(diff)}
            </span>
          </div>
        );
      })}
      {(() => {
        const diffs = recent.map(e => minutesDiff(e[startKey], e[targetKey] || DEFAULT_FILLER_TARGET)).filter(d => d !== null);
        if (diffs.length === 0) return null;
        const avg = diffs.reduce((s, d) => s + d, 0) / diffs.length;
        return (
          <div style={{ marginTop: 8, padding: "6px 10px", background: T.barBg, borderRadius: 6, fontSize: 12, fontFamily: "var(--mono)", color: T.textLight, display: "flex", justifyContent: "space-between" }}>
            <span>5-day avg</span>
            <span style={{ color: avg > 0 ? T.coral : T.teal, fontWeight: 600 }}>{formatMinDiff(Math.round(avg))}</span>
          </div>
        );
      })()}
    </div>
  );
}

function TodayPanel({ data, now, userId, userRole, openComments, commentsRefreshTick, onOpenAddEntry }) {
  const todayDate = productionDateStr(now);
  const todayEntry = data.find(d => d.date === todayDate) || null;
  const [l1Start, setL1Start] = useState("");
  const [l2Start, setL2Start] = useState("");
  const [saving, setSaving] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);

  useEffect(() => {
    setL1Start(todayEntry?.line1_filler_start || "");
    setL2Start(todayEntry?.line2_filler_start || "");
  }, [todayEntry?.date, todayEntry?.line1_filler_start, todayEntry?.line2_filler_start]);

  const canEdit = userRole && userRole !== "viewer";
  const hasTodayEntry = !!todayEntry;

  const saveStart = async (line, value) => {
    if (!hasTodayEntry) return;
    setSaving(line);
    const col = line === 1 ? "line1_filler_start" : "line2_filler_start";
    const { error } = await supabase
      .from("production_entries")
      .update({ [col]: value || null })
      .eq("entry_date", todayDate);
    setSaving(null);
    if (error) { alert("Save failed: " + error.message); return; }
    setSavedMsg(`L${line} saved`);
    setTimeout(() => setSavedMsg(null), 1500);
  };

  const TimeTile = ({ line, color, value, onChange }) => (
    <div style={{ flex: 1, minWidth: 0, padding: "12px 14px", background: T.barBg, borderRadius: 8, border: `1px solid ${T.border}` }}>
      <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color, fontWeight: 700, fontFamily: "var(--mono)", marginBottom: 6 }}>
        Line {line === 1 ? "I" : "II"} Start
      </div>
      <input
        type="time"
        value={value}
        disabled={!canEdit || !hasTodayEntry}
        onChange={(e) => { const v = e.target.value; if (line === 1) setL1Start(v); else setL2Start(v); }}
        onBlur={(e) => { const v = e.target.value; if (v !== (todayEntry?.[`line${line}_filler_start`] || "")) saveStart(line, v); }}
        style={{
          background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 6,
          color: T.text, padding: "8px 10px", fontSize: 16, fontFamily: "var(--mono)",
          width: "100%", boxSizing: "border-box", outline: "none",
          cursor: (!canEdit || !hasTodayEntry) ? "not-allowed" : "text", opacity: (!canEdit || !hasTodayEntry) ? 0.6 : 1,
        }}
      />
      <div style={{ fontSize: 10, color: T.textMid, fontFamily: "var(--mono)", marginTop: 4 }}>
        {value ? `Actual: ${formatTime12(value)}` : "Not set"}
        {todayEntry?.[`line${line}_filler_target`] && <span> · Tgt {formatTime12(todayEntry[`line${line}_filler_target`])}</span>}
        {saving === line && <span style={{ color: T.teal }}> · saving…</span>}
      </div>
    </div>
  );

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>
          Today <span style={{ color: T.textMid, fontSize: 11, textTransform: "none", fontWeight: 600, marginLeft: 6 }}>· {now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
        </div>
        {savedMsg
          ? <span style={{ fontSize: 11, color: T.teal, fontFamily: "var(--mono)" }}>{savedMsg}</span>
          : todayEntry?.last_synced_at && (
            <span style={{ fontSize: 10, color: "#000", fontFamily: "var(--mono)" }} title={`Last synced ${new Date(todayEntry.last_synced_at).toLocaleString()}`}>
              synced {new Date(todayEntry.last_synced_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
      </div>

      {!hasTodayEntry && canEdit && (
        <div style={{ padding: "8px 12px", background: T.tealBg, borderRadius: 6, fontSize: 11, fontFamily: "var(--mono)", color: T.text, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span>No entry for today yet. Create one to log start times.</span>
          <button onClick={() => onOpenAddEntry(todayDate)} style={{ padding: "4px 10px", borderRadius: 5, border: "none", background: T.teal, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)", textTransform: "uppercase" }}>+ Add Today</button>
        </div>
      )}

      {hasTodayEntry && canEdit && (
        <div style={{ padding: "14px 16px", background: T.barBg, borderRadius: 8, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: T.textLight, fontFamily: "var(--mono)" }}>Produced so far</span>
            <button onClick={() => onOpenAddEntry(todayDate)} style={{ padding: "4px 10px", borderRadius: 5, border: "none", background: T.teal, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)", textTransform: "uppercase" }}>Log Production</button>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 22, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: T.teal, fontFamily: "var(--mono)" }}>L1</span>
              <span style={{ fontSize: 36, fontWeight: 800, color: T.teal, fontFamily: "var(--mono)", lineHeight: 1, letterSpacing: -1 }}>{fmt(todayEntry.line1_produced || 0)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: T.coral, fontFamily: "var(--mono)" }}>L2</span>
              <span style={{ fontSize: 36, fontWeight: 800, color: T.coral, fontFamily: "var(--mono)", lineHeight: 1, letterSpacing: -1 }}>{fmt(todayEntry.line2_produced || 0)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginLeft: "auto" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: T.textMid, fontFamily: "var(--mono)" }}>TOTAL</span>
              <span style={{ fontSize: 36, fontWeight: 800, color: T.text, fontFamily: "var(--mono)", lineHeight: 1, letterSpacing: -1 }}>{fmt((todayEntry.line1_produced || 0) + (todayEntry.line2_produced || 0))}</span>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <TimeTile line={1} color={T.teal} value={l1Start} />
        <TimeTile line={2} color={T.coral} value={l2Start} />
      </div>

      <div style={{ paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
        <CommentsList date={todayDate} currentUserId={userId} isManager={userRole === "manager"} refreshTick={commentsRefreshTick} onAddClick={() => openComments(todayDate)} compact />
      </div>
    </div>
  );
}

function WeekComparison({ data, now }) {
  const thisMonday = getMonday(now);
  const lastMonday = new Date(thisMonday); lastMonday.setDate(lastMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday); lastSunday.setDate(lastSunday.getDate() - 1);
  const tw = data.filter(d => { const dd = new Date(d.date + "T12:00:00"); return dd >= thisMonday && dd <= now; });
  const lw = data.filter(d => { const dd = new Date(d.date + "T12:00:00"); return dd >= lastMonday && dd <= lastSunday; });
  const s = (a, k) => a.reduce((s, e) => s + (e[k] || 0), 0);
  const twP = s(tw, "line1_produced") + s(tw, "line2_produced"), twC = s(tw, "line1_capacity") + s(tw, "line2_capacity"), twT = s(tw, "line1_target") + s(tw, "line2_target");
  const lwP = s(lw, "line1_produced") + s(lw, "line2_produced"), lwC = s(lw, "line1_capacity") + s(lw, "line2_capacity"), lwT = s(lw, "line1_target") + s(lw, "line2_target");
  const twE = twT > 0 ? (twP / twT * 100) : null, lwE = lwT > 0 ? (lwP / lwT * 100) : null;
  const fix = (n) => (n != null ? n.toFixed(1) : "—");
  const maxVal = Math.max(twP, lwP, twC, lwC, 1);

  const Bar = ({ val, target, cap, color, label, days }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: T.text, marginBottom: 8, fontFamily: "var(--mono)", fontWeight: 600 }}>{label} <span style={{ color: T.textMid, fontWeight: 400 }}>({days}d)</span></div>
      <div style={{ height: 80, display: "flex", alignItems: "flex-end", marginBottom: 8 }}>
        <div style={{ flex: 1, position: "relative", height: "100%" }}>
          <div title={`Capacity: ${fmt(cap)}`} style={{ height: `${(cap / maxVal) * 100}%`, background: T.barBgFaint, borderRadius: "4px 4px 0 0", position: "absolute", bottom: 0, left: 0, right: 0, border: `1px dashed ${T.borderStrong}` }} />
          <div title={`Produced: ${fmt(val)}`} style={{ height: `${(val / maxVal) * 100}%`, background: color, borderRadius: "4px 4px 0 0", minHeight: val > 0 ? 4 : 0, position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 1, transition: "height 0.8s ease" }} />
          {target > 0 && (
            <div title={`Target: ${fmt(target)}`} style={{ position: "absolute", bottom: `${(target / maxVal) * 100}%`, left: -3, right: -3, height: 2, background: T.text, zIndex: 2 }} />
          )}
        </div>
      </div>
      <div style={{ fontFamily: "var(--mono)" }}><div style={{ fontSize: 18, fontWeight: 700, color }}>{fmt(val)}</div></div>
    </div>
  );

  const Legend = () => (
    <div style={{ display: "flex", gap: 14, fontSize: 11, fontFamily: "var(--mono)", color: T.textMid, flexWrap: "wrap", marginBottom: 10 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 10, height: 8, background: T.teal, borderRadius: 2 }} /> Produced</span>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 14, height: 2, background: T.text }} /> Target line</span>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 10, height: 8, background: "transparent", border: `1px dashed ${T.borderStrong}`, borderRadius: 2 }} /> Capacity</span>
    </div>
  );

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>This Week vs Last Week</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {(uniqueProducts(tw).length > 1 || uniqueProducts(lw).length > 1) && <SkuTag kind="mixed" />}
          <span title="Change in % of target hit (plant performance), not a change in the target itself"><ChangeIndicator value={ppDelta(twE, lwE)} suffix="pp tgt" /></span>
        </div>
      </div>
      <Legend />
      <div style={{ display: "flex", gap: 20 }}>
        <Bar val={twP} target={twT} cap={twC} color={T.teal} label="This Week" days={tw.length} />
        <div style={{ width: 1, background: T.border }} />
        <Bar val={lwP} target={lwT} cap={lwC} color={T.textMid} label="Last Week" days={lw.length} />
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 14, fontSize: 12, fontFamily: "var(--mono)", color: T.textLight, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
        <span>Tgt hit: <span style={{ color: T.teal, fontWeight: 600 }}>{fix(twE)}%</span> vs <span style={{ fontWeight: 600 }}>{fix(lwE)}%</span></span>
      </div>
    </div>
  );
}

function DataEntry({ onSave, onClose, existingData, userRole, initialDate }) {
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const [date, setDate] = useState(initialDate || localDateStr(yest));
  const [product, setProduct] = useState("Sunberry");
  const [daily, setDaily] = useState({ line1_produced: "", line1_filler_start: "", line2_produced: "", line2_filler_start: "", notes: "" });
  const [defaults, setDefaults] = useState(null);
  const [existingSpecs, setExistingSpecs] = useState(null);
  // last values the live sync wrote for the selected day (null = never synced)
  const [synced, setSynced] = useState({ line1_produced: null, line2_produced: null, line1_filler_start: null, line2_filler_start: null });
  const [editingDefaults, setEditingDefaults] = useState(false);
  const [draftDefaults, setDraftDefaults] = useState(null);
  const [savingDefaults, setSavingDefaults] = useState(false);

  const isManager = userRole === "manager";
  const isEditing = !!existingSpecs;
  const activeSpecs = existingSpecs || defaults;

  useEffect(() => {
    const e = existingData.find(d => d.date === date);
    if (e) {
      setDaily({
        line1_produced: e.line1_produced?.toString() || "",
        line1_filler_start: e.line1_filler_start || "",
        line2_produced: e.line2_produced?.toString() || "",
        line2_filler_start: e.line2_filler_start || "",
        notes: e.notes || "",
      });
      setProduct(e.product || "Sunberry");
      setExistingSpecs({
        line1_target: e.line1_target,
        line1_capacity: e.line1_capacity,
        line1_filler_target: e.line1_filler_target || DEFAULT_FILLER_TARGET,
        line2_target: e.line2_target,
        line2_capacity: e.line2_capacity,
        line2_filler_target: e.line2_filler_target || DEFAULT_FILLER_TARGET,
      });
      setSynced({
        line1_produced: e.line1_produced_synced ?? null,
        line2_produced: e.line2_produced_synced ?? null,
        line1_filler_start: e.line1_filler_start_synced ?? null,
        line2_filler_start: e.line2_filler_start_synced ?? null,
      });
    } else {
      setDaily({ line1_produced: "", line1_filler_start: "", line2_produced: "", line2_filler_start: "", notes: "" });
      setExistingSpecs(null);
      setSynced({ line1_produced: null, line2_produced: null, line1_filler_start: null, line2_filler_start: null });
    }
  }, [date]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("product_defaults")
        .select("*")
        .eq("product", product)
        .single();
      if (cancelled) return;
      if (error) { console.error("defaults fetch failed", error); setDefaults(null); return; }
      setDefaults({
        line1_target: data.line1_target,
        line1_capacity: data.line1_capacity,
        line1_filler_target: trimTime(data.line1_filler_target) || DEFAULT_FILLER_TARGET,
        line2_target: data.line2_target,
        line2_capacity: data.line2_capacity,
        line2_filler_target: trimTime(data.line2_filler_target) || DEFAULT_FILLER_TARGET,
      });
    })();
    return () => { cancelled = true; };
  }, [product]);

  const updateDaily = (k, v) => setDaily(p => ({ ...p, [k]: v }));
  const updateDraft = (k, v) => setDraftDefaults(p => ({ ...p, [k]: v }));

  const startEditDefaults = () => { setDraftDefaults({ ...defaults }); setEditingDefaults(true); };
  const cancelEditDefaults = () => { setEditingDefaults(false); setDraftDefaults(null); };

  const saveDefaultsToDb = async () => {
    setSavingDefaults(true);
    const payload = {
      product,
      line1_target: parseInt(draftDefaults.line1_target) || 0,
      line1_capacity: parseInt(draftDefaults.line1_capacity) || 0,
      line1_filler_target: draftDefaults.line1_filler_target || null,
      line2_target: parseInt(draftDefaults.line2_target) || 0,
      line2_capacity: parseInt(draftDefaults.line2_capacity) || 0,
      line2_filler_target: draftDefaults.line2_filler_target || null,
    };
    const { data: saved, error } = await supabase
      .from("product_defaults")
      .upsert(payload, { onConflict: "product" })
      .select()
      .single();
    setSavingDefaults(false);
    if (error || !saved) {
      alert("Could not save defaults: " + (error?.message || "no row returned — check Supabase RLS / unique constraint on product"));
      return;
    }
    const mismatch =
      saved.line1_target !== payload.line1_target ||
      saved.line1_capacity !== payload.line1_capacity ||
      saved.line2_target !== payload.line2_target ||
      saved.line2_capacity !== payload.line2_capacity;
    if (mismatch) {
      alert("Defaults did not persist correctly. Saved row does not match what was sent — likely a Supabase permission / constraint issue.");
      return;
    }
    setDefaults({
      line1_target: saved.line1_target,
      line1_capacity: saved.line1_capacity,
      line1_filler_target: trimTime(saved.line1_filler_target) || DEFAULT_FILLER_TARGET,
      line2_target: saved.line2_target,
      line2_capacity: saved.line2_capacity,
      line2_filler_target: trimTime(saved.line2_filler_target) || DEFAULT_FILLER_TARGET,
    });
    setEditingDefaults(false);
    setDraftDefaults(null);
  };

  const startEditEntrySpecs = () => { setDraftDefaults({ ...existingSpecs }); setEditingDefaults(true); };
  const saveEntrySpecsLocal = () => {
    setExistingSpecs({
      line1_target: parseInt(draftDefaults.line1_target) || 0,
      line1_capacity: parseInt(draftDefaults.line1_capacity) || 0,
      line1_filler_target: draftDefaults.line1_filler_target || DEFAULT_FILLER_TARGET,
      line2_target: parseInt(draftDefaults.line2_target) || 0,
      line2_capacity: parseInt(draftDefaults.line2_capacity) || 0,
      line2_filler_target: draftDefaults.line2_filler_target || DEFAULT_FILLER_TARGET,
    });
    setEditingDefaults(false);
    setDraftDefaults(null);
  };

  const handleSave = () => {
    if (!activeSpecs) { alert("Defaults not loaded yet — try again in a moment."); return; }

    // A produced/start value the user typed that differs from the last synced
    // value is a manual override → it wins over future syncs. A blank field, or
    // one matching the synced value ("use live"), stays on auto.
    const resolveProduced = (n) => {
      const str = daily[`line${n}_produced`];
      const num = str === "" ? 0 : (parseInt(str) || 0);
      const syncedVal = synced[`line${n}_produced`];
      const manual = str !== "" && (syncedVal == null || num !== syncedVal);
      return { value: manual ? num : (syncedVal ?? num), manual };
    };
    const resolveStart = (n) => {
      const str = daily[`line${n}_filler_start`];
      const syncedVal = synced[`line${n}_filler_start`];
      const manual = str !== "" && (syncedVal == null || str !== syncedVal);
      return { value: manual ? str : (syncedVal ?? (str || null)), manual };
    };
    const p1 = resolveProduced(1), p2 = resolveProduced(2);
    const s1 = resolveStart(1), s2 = resolveStart(2);

    onSave({
      date,
      product,
      line1_produced: p1.value,
      line1_target: activeSpecs.line1_target,
      line1_capacity: activeSpecs.line1_capacity,
      line1_filler_start: s1.value,
      line1_filler_target: activeSpecs.line1_filler_target,
      line2_produced: p2.value,
      line2_target: activeSpecs.line2_target,
      line2_capacity: activeSpecs.line2_capacity,
      line2_filler_start: s2.value,
      line2_filler_target: activeSpecs.line2_filler_target,
      notes: daily.notes.trim(),
      line1_produced_manual: p1.manual,
      line2_produced_manual: p2.manual,
      line1_filler_start_manual: s1.manual,
      line2_filler_start_manual: s2.manual,
    });
  };

  const S = { background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 6, color: T.text, padding: "10px 12px", fontSize: 14, fontFamily: "var(--mono)", width: "100%", boxSizing: "border-box", outline: "none" };
  const L = { fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: T.textLight, marginBottom: 4, fontFamily: "var(--mono)" };

  return (
    <div style={{ position: "fixed", inset: 0, background: T.modalOverlay, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(10px)" }}>
      <div style={{ background: T.modalBg, border: `1px solid ${T.borderStrong}`, borderRadius: 16, padding: 28, width: "92%", maxWidth: 620, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: T.text, fontFamily: "var(--body)" }}>+ Log Production</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textLight, fontSize: 28, cursor: "pointer" }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <div style={L}>Date</div>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={S} />
            <div style={{ fontSize: 11, color: T.textFaint, marginTop: 3 }}>Defaults to yesterday</div>
          </div>
          <div>
            <div style={L}>Product</div>
            <select value={product} onChange={e => setProduct(e.target.value)} style={{ ...S, cursor: isEditing ? "not-allowed" : "pointer", opacity: isEditing ? 0.6 : 1 }} disabled={isEditing}>
              {["Sunberry", "Arizona/Sunberry", "Arizona", "Other"].map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            {isEditing && <div style={{ fontSize: 11, color: T.textFaint, marginTop: 3 }}>Locked — entry already saved with this product</div>}
          </div>
        </div>

        <div style={{ padding: "12px 14px", borderRadius: 8, background: T.barBg, marginBottom: 14 }}>
          {editingDefaults ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 6, flexWrap: "wrap" }}>
                <div style={{ fontSize: 12, letterSpacing: 1.5, textTransform: "uppercase", color: T.textMid, fontFamily: "var(--mono)" }}>{isEditing ? "Edit Specs for This Entry" : `Edit Defaults · ${product}`}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={cancelEditDefaults} disabled={savingDefaults} style={{ padding: "5px 10px", borderRadius: 5, border: `1px solid ${T.borderStrong}`, background: "transparent", color: T.textMid, fontSize: 12, fontFamily: "var(--mono)", textTransform: "uppercase", cursor: "pointer" }}>Cancel</button>
                  <button onClick={isEditing ? saveEntrySpecsLocal : saveDefaultsToDb} disabled={savingDefaults} style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: T.teal, color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "var(--mono)", textTransform: "uppercase", cursor: savingDefaults ? "wait" : "pointer" }}>{savingDefaults ? "Saving..." : (isEditing ? "Apply" : "Save Defaults")}</button>
                </div>
              </div>
              {isEditing && <div style={{ fontSize: 11, color: T.textFaint, marginBottom: 8, fontFamily: "var(--mono)" }}>Applies to this entry only — saved when you click Save Entry below.</div>}
              {[1, 2].map(n => (
                <div key={n} style={{ marginBottom: n === 1 ? 10 : 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: n === 1 ? T.teal : T.coral, marginBottom: 6, fontFamily: "var(--mono)" }}>LINE {n === 1 ? "I" : "II"}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <div><div style={L}>Target</div><input type="number" value={draftDefaults?.[`line${n}_target`] ?? ""} onChange={e => updateDraft(`line${n}_target`, e.target.value)} style={S} /></div>
                    <div><div style={L}>Capacity</div><input type="number" value={draftDefaults?.[`line${n}_capacity`] ?? ""} onChange={e => updateDraft(`line${n}_capacity`, e.target.value)} style={S} /></div>
                    <div><div style={L}>Filler Tgt</div><input type="time" value={draftDefaults?.[`line${n}_filler_target`] || ""} onChange={e => updateDraft(`line${n}_filler_target`, e.target.value)} style={S} /></div>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 6 }}>
                <div style={{ fontSize: 12, letterSpacing: 1.5, textTransform: "uppercase", color: T.textMid, fontFamily: "var(--mono)" }}>
                  {isEditing ? "Specs (saved with this entry)" : `Defaults · ${product}`}
                </div>
                {isManager && !isEditing && defaults && (
                  <button onClick={startEditDefaults} style={{ background: "transparent", border: `1px solid ${T.borderStrong}`, color: T.teal, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)", textTransform: "uppercase", padding: "3px 8px", borderRadius: 4 }}>Edit</button>
                )}
                {isManager && isEditing && existingSpecs && (
                  <button onClick={startEditEntrySpecs} style={{ background: "transparent", border: `1px solid ${T.borderStrong}`, color: T.teal, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)", textTransform: "uppercase", padding: "3px 8px", borderRadius: 4 }}>Edit</button>
                )}
              </div>
              {activeSpecs ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 11, fontFamily: "var(--mono)", color: T.textMid }}>
                  <div>
                    <span style={{ color: T.teal, fontWeight: 600 }}>L1</span> Tgt {fmt(activeSpecs.line1_target)} · Cap {fmt(activeSpecs.line1_capacity)} · Filler {formatTime12(activeSpecs.line1_filler_target)}
                  </div>
                  <div>
                    <span style={{ color: T.coral, fontWeight: 600 }}>L2</span> Tgt {fmt(activeSpecs.line2_target)} · Cap {fmt(activeSpecs.line2_capacity)} · Filler {formatTime12(activeSpecs.line2_filler_target)}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic" }}>Loading defaults...</div>
              )}
            </>
          )}
        </div>

        {[{ n: 1, c: T.teal, l: "LINE I" }, { n: 2, c: T.coral, l: "LINE II" }].map(({ n, c, l }) => (
          <div key={n} style={{ padding: "12px 0", borderTop: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: c, marginBottom: 10, fontFamily: "var(--mono)" }}>{l}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div style={L}>Produced</div>
                <input type="number" placeholder="0" value={daily[`line${n}_produced`]} onChange={e => updateDaily(`line${n}_produced`, e.target.value)} style={S} />
                {synced[`line${n}_produced`] != null && (
                  <div style={{ fontSize: 10, color: T.textMid, fontFamily: "var(--mono)", marginTop: 3 }}>
                    live: {fmt(synced[`line${n}_produced`])}
                    {String(synced[`line${n}_produced`]) !== String(daily[`line${n}_produced`]) && (
                      <button type="button" onClick={() => updateDaily(`line${n}_produced`, String(synced[`line${n}_produced`]))}
                        style={{ marginLeft: 6, background: "none", border: "none", color: T.teal, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10, padding: 0, textDecoration: "underline" }}>use live</button>
                    )}
                  </div>
                )}
              </div>
              <div>
                <div style={L}>Filler Actual Start</div>
                <input type="time" value={daily[`line${n}_filler_start`]} onChange={e => updateDaily(`line${n}_filler_start`, e.target.value)} style={S} />
                {synced[`line${n}_filler_start`] != null && (
                  <div style={{ fontSize: 10, color: T.textMid, fontFamily: "var(--mono)", marginTop: 3 }}>
                    live: {synced[`line${n}_filler_start`]}
                    {synced[`line${n}_filler_start`] !== daily[`line${n}_filler_start`] && (
                      <button type="button" onClick={() => updateDaily(`line${n}_filler_start`, synced[`line${n}_filler_start`])}
                        style={{ marginLeft: 6, background: "none", border: "none", color: T.teal, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10, padding: 0, textDecoration: "underline" }}>use live</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}

        <div style={{ padding: "12px 0", borderTop: `1px solid ${T.border}` }}>
          <div style={L}>Shift Notes</div>
          <textarea value={daily.notes} onChange={e => updateDaily("notes", e.target.value)} placeholder="e.g. Line 2 CIP ran long, short-staffed..." rows={2} style={{ ...S, resize: "vertical", lineHeight: 1.5, minHeight: 48 }} />
        </div>

        <button onClick={handleSave} disabled={!activeSpecs} style={{ marginTop: 14, width: "100%", padding: "13px", background: activeSpecs ? `linear-gradient(135deg, ${T.teal}, #0C8C87)` : T.textLight, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: activeSpecs ? "pointer" : "wait", fontFamily: "var(--mono)", letterSpacing: 1, textTransform: "uppercase" }}>Save Entry</button>
      </div>
    </div>
  );
}

function TargetsModal({ onClose, onSaved, current, effectiveDate }) {
  const [f, setF] = useState({
    line1_target: current?.line1_target ?? "",
    line1_capacity: current?.line1_capacity ?? "",
    line2_target: current?.line2_target ?? "",
    line2_capacity: current?.line2_capacity ?? "",
    filler_start_target: current?.filler_start_target ? String(current.filler_start_target).slice(0, 5) : "",
  });
  const [saving, setSaving] = useState(false);
  const upd = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setSaving(true);
    const num = (v) => (v === "" ? null : parseInt(v) || 0);
    const row = {
      effective_from: effectiveDate,
      line1_target: num(f.line1_target),
      line1_capacity: num(f.line1_capacity),
      line2_target: num(f.line2_target),
      line2_capacity: num(f.line2_capacity),
      filler_start_target: f.filler_start_target || null,
    };
    const { error } = await supabase.from("production_targets").upsert(row, { onConflict: "effective_from" });
    // keep the Log Production form's prefill in sync (best effort)
    await supabase.from("product_defaults").upsert({
      product: "Sunberry",
      line1_target: row.line1_target, line1_capacity: row.line1_capacity, line1_filler_target: row.filler_start_target,
      line2_target: row.line2_target, line2_capacity: row.line2_capacity, line2_filler_target: row.filler_start_target,
    }, { onConflict: "product" });
    setSaving(false);
    if (error) { alert("Save failed: " + error.message); return; }
    onSaved();
    onClose();
  };

  const S = { background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 6, color: T.text, padding: "10px 12px", fontSize: 14, fontFamily: "var(--mono)", width: "100%", boxSizing: "border-box", outline: "none" };
  const L = { fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: T.textLight, marginBottom: 4, fontFamily: "var(--mono)" };

  return (
    <div style={{ position: "fixed", inset: 0, background: T.modalOverlay, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(10px)" }}>
      <div style={{ background: T.modalBg, border: `1px solid ${T.borderStrong}`, borderRadius: 16, padding: 28, width: "92%", maxWidth: 520, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: T.text, fontFamily: "var(--body)" }}>⚙ Default Targets</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textLight, fontSize: 28, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ fontSize: 11, color: T.textMid, fontFamily: "var(--mono)", marginBottom: 18, lineHeight: 1.5 }}>
          Applies from <b>{effectiveDate}</b> forward. Past days keep their values; a per-day edit still overrides for that day.
        </div>

        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.teal, marginBottom: 10, fontFamily: "var(--mono)" }}>LINE I</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><div style={L}>Target</div><input type="number" value={f.line1_target} onChange={(e) => upd("line1_target", e.target.value)} style={S} /></div>
            <div><div style={L}>Capacity</div><input type="number" value={f.line1_capacity} onChange={(e) => upd("line1_capacity", e.target.value)} style={S} /></div>
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.coral, marginBottom: 10, fontFamily: "var(--mono)" }}>LINE II</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><div style={L}>Target</div><input type="number" value={f.line2_target} onChange={(e) => upd("line2_target", e.target.value)} style={S} /></div>
            <div><div style={L}>Capacity</div><input type="number" value={f.line2_capacity} onChange={(e) => upd("line2_capacity", e.target.value)} style={S} /></div>
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
          <div style={L}>Filler Start Target (both lines)</div>
          <input type="time" value={f.filler_start_target} onChange={(e) => upd("filler_start_target", e.target.value)} style={{ ...S, maxWidth: 160 }} />
        </div>

        <button onClick={save} disabled={saving} style={{ marginTop: 18, width: "100%", padding: "13px", background: `linear-gradient(135deg, ${T.teal}, #0C8C87)`, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: saving ? "wait" : "pointer", fontFamily: "var(--mono)", letterSpacing: 1, textTransform: "uppercase" }}>{saving ? "Saving…" : "Save (effective today)"}</button>
      </div>
    </div>
  );
}

export default function ProductionDashboard({ signOut, userId, userEmail, userRole }) {
  const [data, setData] = useState([]);
  const [showEntry, setShowEntry] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [view, setView] = useState("dashboard");
  const [notesOpen, setNotesOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [targets, setTargets] = useState([]);
  const [targetsOpen, setTargetsOpen] = useState(false);

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  const loadData = useCallback(async () => {
    const [entriesRes, targetsRes] = await Promise.all([
      supabase.from("production_entries").select("*").order("entry_date", { ascending: false }),
      supabase.from("production_targets").select("*").order("effective_from", { ascending: true }),
    ]);
    if (entriesRes.error) console.error("load entries failed", entriesRes.error);
    if (targetsRes.error) console.error("load targets failed", targetsRes.error);
    const tgts = targetsRes.data || [];
    setTargets(tgts);
    if (!entriesRes.error) {
      setData((entriesRes.data || []).map(rowToEntry).map((e) => {
        // Fill target/cap/filler-target from the effective default for that day,
        // but only where the row has no value (a per-day override wins).
        const d = effectiveTargets(e.date, tgts);
        if (!d) return e;
        return {
          ...e,
          line1_target: e.line1_target ?? d.line1_target,
          line1_capacity: e.line1_capacity ?? d.line1_capacity,
          line2_target: e.line2_target ?? d.line2_target,
          line2_capacity: e.line2_capacity ?? d.line2_capacity,
          line1_filler_target: e.line1_filler_target ?? trimTime(d.filler_start_target),
          line2_filler_target: e.line2_filler_target ?? trimTime(d.filler_start_target),
        };
      }));
    }
    setLoading(false);
  }, []);
  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { const t = setInterval(loadData, 30000); return () => clearInterval(t); }, [loadData]);

  // Pull today's live numbers on demand. The Edge Function holds the API token
  // server-side and writes via apply_production_sync (manual values are kept).
  const syncNow = useCallback(async () => {
    setSyncing(true);
    const { data: result, error } = await supabase.functions.invoke("sync-production", { body: {} });
    setSyncing(false);
    if (error || result?.error) { alert("Sync failed: " + (error?.message || result?.error)); return; }
    await loadData();
  }, [loadData]);

  const saveEntry = async (entry) => {
    const { error } = await supabase
      .from("production_entries")
      .upsert(entryToRow(entry), { onConflict: "entry_date" });
    if (error) { console.error("save entry failed", error); alert("Save failed: " + error.message); return; }
    await loadData();
    closeEntry();
  };

  const [editDate, setEditDate] = useState(null);
  const openEntry = (date) => { setEditDate(date || null); setShowEntry(true); };
  const closeEntry = () => { setEditDate(null); setShowEntry(false); };

  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsDate, setCommentsDate] = useState(null);
  const [commentsRefreshTick, setCommentsRefreshTick] = useState(0);
  const openComments = (date) => { setCommentsDate(date || null); setCommentsOpen(true); };
  const closeComments = () => { setCommentsOpen(false); setCommentsDate(null); setCommentsRefreshTick(t => t + 1); };

  const [selectedDate, setSelectedDate] = useState(null);

  const sum = (a, k) => a.reduce((s, e) => s + (e[k] || 0), 0);
  const todayDateStr = productionDateStr(now);
  const historical = data.filter(d => d.date < todayDateStr);
  const sorted = [...historical].sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0] || null, previous = sorted[1] || null;
  useEffect(() => {
    if (selectedDate == null) setSelectedDate(todayDateStr);
  }, [selectedDate, todayDateStr]);
  // resolve from full data (incl. today) so Day View can show the live day
  const selectedEntry = selectedDate ? data.find(d => d.date === selectedDate) : null;
  const selTotal = eTotal(selectedEntry), selTarget = eTarget(selectedEntry), selCap = eCap(selectedEntry);
  const latestTotal = eTotal(latest), latestTarget = eTarget(latest), latestCap = eCap(latest), prevTotal = eTotal(previous);
  const last5 = sorted.slice(0, 5), prev5 = sorted.slice(5, 10);
  const avg5 = last5.length > 0 ? last5.reduce((s, e) => s + eTotal(e), 0) / last5.length : 0;
  const last5Eff = aggEff(last5), prev5Eff = aggEff(prev5);
  const last5Mixed = uniqueProducts(last5).length > 1 || uniqueProducts(prev5).length > 1;
  const diffSku = latest && previous && latest.product && previous.product && latest.product !== previous.product;
  const weekEntries = historical.filter(d => { const dd = new Date(d.date + "T12:00:00"); return getWeekNumber(dd) === getWeekNumber(now) && dd.getFullYear() === now.getFullYear(); });
  const monthEntries = historical.filter(d => { const dd = new Date(d.date + "T12:00:00"); return dd.getMonth() === now.getMonth() && dd.getFullYear() === now.getFullYear(); });
  const weekP = sum(weekEntries, "line1_produced") + sum(weekEntries, "line2_produced"), weekT = sum(weekEntries, "line1_target") + sum(weekEntries, "line2_target"), weekC = sum(weekEntries, "line1_capacity") + sum(weekEntries, "line2_capacity");
  const monthP = sum(monthEntries, "line1_produced") + sum(monthEntries, "line2_produced"), monthT = sum(monthEntries, "line1_target") + sum(monthEntries, "line2_target"), monthC = sum(monthEntries, "line1_capacity") + sum(monthEntries, "line2_capacity");
  const latestEff = eEff(latest), prevEff = eEff(previous);
  const weekEff = weekT > 0 ? (weekP / weekT) * 100 : null;
  const weekCap = weekC > 0 ? (weekP / weekC) * 100 : null;
  const monthEff = monthT > 0 ? (monthP / monthT) * 100 : null;
  const last5P = last5.reduce((s, e) => s + eTotal(e), 0);
  const last5C = last5.reduce((s, e) => s + eCap(e), 0);
  const last5Cap = last5C > 0 ? (last5P / last5C) * 100 : null;
  const prevTarget = previous ? eTarget(previous) : 0;
  const prevCap_ = previous ? eCap(previous) : 0;
  const weekRangeLabel = weekEntries.length > 0
    ? `${formatDate([...weekEntries].sort((a,b)=>a.date.localeCompare(b.date))[0].date)} – ${formatDate([...weekEntries].sort((a,b)=>b.date.localeCompare(a.date))[0].date)}`
    : "—";
  const recent = sorted.slice(0, 7).reverse();
  const pendingEntries = historical.filter(e => (e.line1_produced || 0) === 0 && (e.line2_produced || 0) === 0);

  if (loading) return <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ fontFamily: "'JetBrains Mono', monospace", color: T.textLight }}>Loading...</div></div>;

  return (
    <div style={{ "--mono": "'JetBrains Mono', monospace", "--body": "'Outfit', sans-serif", minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "var(--body)", position: "relative" }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&family=Outfit:wght@300;400;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ position: "absolute", inset: 0, opacity: 0.025, backgroundImage: "linear-gradient(rgba(0,0,0,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.3) 1px, transparent 1px)", backgroundSize: "40px 40px", pointerEvents: "none" }} />

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 22px", borderBottom: `1px solid ${T.border}`, position: "relative", zIndex: 1, background: T.bg, flexWrap: "wrap", gap: 12, rowGap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "0 1 auto", minWidth: 0 }}>
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: latest ? T.teal : T.textFaint, boxShadow: latest ? `0 0 10px ${T.teal}` : "none", flexShrink: 0 }} />
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: -0.5, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>SUNBERRY FARMS PRODUCTION</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", rowGap: 10 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", lineHeight: 1, color: T.text }}>{now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
            <div style={{ fontSize: 12, color: T.textLight, fontFamily: "var(--mono)" }}>{now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
          </div>
          <div style={{ display: "flex", gap: 5 }}>
            {["dashboard", "history"].map(v => (
              <button key={v} onClick={() => setView(v)} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.borderStrong}`, background: view === v ? T.barBg : "transparent", color: T.text, fontSize: 12, cursor: "pointer", fontFamily: "var(--mono)", textTransform: "uppercase" }}>{v === "dashboard" ? "Dash" : "Log"}</button>
            ))}
            {userRole !== "viewer" && (
              <button onClick={syncNow} disabled={syncing} title="Pull today's live numbers from the scanner" style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.borderStrong}`, background: "transparent", color: T.text, fontSize: 12, fontWeight: 700, cursor: syncing ? "wait" : "pointer", fontFamily: "var(--mono)", opacity: syncing ? 0.6 : 1 }}>{syncing ? "⟳ Syncing…" : "⟳ Sync"}</button>
            )}
            {userRole !== "viewer" && (
              <button onClick={() => setTargetsOpen(true)} title="Set default targets, caps and filler start (effective from today)" style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.borderStrong}`, background: "transparent", color: T.text, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)" }}>⚙ Targets</button>
            )}
            {userRole !== "viewer" && (
              <button onClick={() => openEntry(null)} style={{ padding: "7px 12px", borderRadius: 6, border: "none", background: T.teal, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)" }}>+ ADD</button>
            )}
            <button onClick={() => openComments(null)} title="Add or view comments" style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.borderStrong}`, background: "transparent", color: T.text, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)" }}>💬 Comment</button>
          </div>
          {signOut && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 10, marginLeft: 4, borderLeft: `1px solid ${T.border}` }}>
              <div style={{ textAlign: "right", fontFamily: "var(--mono)", lineHeight: 1.2, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: T.text, fontWeight: 600, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={userEmail}>{userEmail}</div>
                {userRole && <div style={{ fontSize: 10, color: T.textLight, letterSpacing: 1.5, textTransform: "uppercase" }}>{userRole.replace("_", " ")}</div>}
              </div>
              <button onClick={signOut} title="Sign out" style={{ padding: "7px 10px", borderRadius: 6, border: `1px solid ${T.borderStrong}`, background: "transparent", color: T.textMid, fontSize: 12, cursor: "pointer", fontFamily: "var(--mono)", textTransform: "uppercase" }}>Sign out</button>
            </div>
          )}
        </div>
      </div>

      {showEntry && <DataEntry onSave={saveEntry} onClose={closeEntry} existingData={data} userRole={userRole} initialDate={editDate} />}
      {commentsOpen && <CommentsModal onClose={closeComments} initialDate={commentsDate} currentUserId={userId} isManager={userRole === "manager"} />}
      {targetsOpen && <TargetsModal onClose={() => setTargetsOpen(false)} onSaved={loadData} current={effectiveTargets(productionDateStr(now), targets)} effectiveDate={productionDateStr(now)} />}

      {view === "dashboard" ? (
        <div style={{ padding: "18px 22px 80px", position: "relative", zIndex: 1 }}>
          {pendingEntries.length > 0 && userRole !== "viewer" && (
            <div style={{ padding: "10px 14px", background: T.goldBg, border: `1px solid ${T.gold}`, borderRadius: 8, marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: T.text }}>
                <span style={{ fontWeight: 700, color: T.gold, marginRight: 6 }}>⚠ Pending update:</span>
                {pendingEntries.length === 1
                  ? `1 day has 0 cases logged (${formatDayShort(pendingEntries[0].date)}). Fill in produced numbers so rollups stay accurate.`
                  : `${pendingEntries.length} days have 0 cases logged. Fill in produced numbers so rollups stay accurate.`}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {pendingEntries.slice(0, 4).map(e => (
                  <button key={e.date} onClick={() => openEntry(e.date)} style={{ padding: "4px 10px", borderRadius: 5, border: `1px solid ${T.gold}`, background: "transparent", color: T.text, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)" }}>
                    Fix {formatDate(e.date)}
                  </button>
                ))}
                {pendingEntries.length > 4 && <span style={{ fontSize: 11, color: T.textMid, fontFamily: "var(--mono)", alignSelf: "center" }}>+{pendingEntries.length - 4} more</span>}
              </div>
            </div>
          )}

          {/* Today is the focus on open — keep it at the top */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 12, marginBottom: 18 }}>
            <TodayPanel data={data} now={now} userId={userId} userRole={userRole} openComments={openComments} commentsRefreshTick={commentsRefreshTick} onOpenAddEntry={openEntry} />
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, textAlign: "center" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>
                  Day View {selectedEntry && <span style={{ color: T.text, fontSize: 11, textTransform: "none", fontWeight: 600 }}>({formatDayShort(selectedEntry.date)} · {selectedEntry.product})</span>}
                </div>
                <input type="date" value={selectedDate || ""} max={todayDateStr} onChange={e => { const v = e.target.value; if (v && v <= todayDateStr) setSelectedDate(v); }} style={{ background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 5, color: T.text, padding: "5px 9px", fontSize: 12, fontFamily: "var(--mono)", outline: "none", cursor: "pointer" }} />
              </div>
              {!selectedEntry && selectedDate && (
                <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic", padding: "10px 0" }}>No production data for this date.</div>
              )}
              <div style={{ display: "flex", justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
                <DualGauge produced={selectedEntry?.line1_produced || 0} target={selectedEntry?.line1_target || 1} capacity={selectedEntry?.line1_capacity || 1} label="Line I" colorA={T.teal} />
                <DualGauge produced={selectedEntry?.line2_produced || 0} target={selectedEntry?.line2_target || 1} capacity={selectedEntry?.line2_capacity || 1} label="Line II" colorA={T.coral} />
                <DualGauge produced={selTotal} target={selTarget || 1} capacity={selCap || 1} label="Combined" colorA={T.gold} />
              </div>
              {selectedEntry?.notes && <div style={{ marginTop: 10, padding: "7px 12px", background: T.tealBg, borderRadius: 6, fontSize: 11, color: T.textMid, fontStyle: "italic", textAlign: "left" }}>💬 {selectedEntry.notes}</div>}
              {selectedDate && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}`, textAlign: "left" }}>
                  <CommentsList date={selectedDate} currentUserId={userId} isManager={userRole === "manager"} refreshTick={commentsRefreshTick} onAddClick={() => openComments(selectedDate)} compact />
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10, marginBottom: 18 }}>
            <StatCard title="Latest" titleDetail={latest ? formatDayShort(latest.date) : ""} value={latest ? fmt(latestTotal) : "—"}
              sub={latest ? `Tgt: ${fmt(latestTarget)} · Cap: ${fmt(latestCap)}\nCap hit: ${pc(latestTotal, latestCap)}% · Tgt hit: ${pc(latestTotal, latestTarget)}%` : "No entries yet"}
              accent={perfColor(latestEff)} change={ppDelta(latestEff, prevEff)} changeSuffix="pp vs prev"
              tag={diffSku ? <SkuTag kind="different" /> : null} />
            <StatCard title="Previous" titleDetail={previous ? formatDayShort(previous.date) : ""} value={previous ? fmt(prevTotal) : "—"}
              sub={previous ? `Tgt: ${fmt(prevTarget)} · Cap: ${fmt(prevCap_)}\nCap hit: ${pc(prevTotal, prevCap_)}% · Tgt hit: ${pc(prevTotal, prevTarget)}%` : "—"} accent={perfColor(prevEff)} />
            <StatCard title="5-Day Avg" value={fmt(Math.round(avg5))}
              sub={`${last5.length}d rolling\nCap hit: ${last5Cap != null ? last5Cap.toFixed(1) + "%" : "—"} · Tgt hit: ${last5Eff != null ? last5Eff.toFixed(1) + "%" : "—"}`}
              accent={perfColor(last5Eff)} change={ppDelta(last5Eff, prev5Eff)} changeSuffix="pp vs prev 5"
              tag={last5Mixed ? <SkuTag kind="mixed" /> : null} />
            <StatCard title="This Week" value={fmt(weekP)}
              sub={`${weekRangeLabel} · ${weekEntries.length}d\nCap hit: ${pc(weekP, weekC)}% · Tgt hit: ${pc(weekP, weekT)}%`}
              accent={perfColor(weekEff)} />
            <MonthlyProgressCard monthEntries={monthEntries} now={now} isManager={userRole === "manager"} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 14, marginTop: -10, marginBottom: 14, fontSize: 10, fontFamily: "var(--mono)", color: T.textMid }}>
            <span style={{ letterSpacing: 1, textTransform: "uppercase" }}>Tgt hit color:</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, background: T.teal, borderRadius: "50%" }} /> ≥ 90% on track</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, background: T.gold, borderRadius: "50%" }} /> 75–89% watch</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, background: T.coral, borderRadius: "50%" }} /> {"<"} 75% behind</span>
          </div>

          <div style={{ marginBottom: 18 }}>
            <WeekComparison data={historical} now={now} />
          </div>

          <MonthComparison data={historical} />
          <NotesPanel entries={historical} expanded={notesOpen} onToggle={() => setNotesOpen(!notesOpen)} />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12, marginBottom: 18 }}>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}><FillerCard entries={historical} line={1} /></div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}><FillerCard entries={historical} line={2} /></div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 12 }}>
            {[{ label: "Line I", key: "line1", color: T.teal }, { label: "Line II", key: "line2", color: T.coral }].map(({ label, key, color }) => (
              <div key={key} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, marginBottom: 12, fontFamily: "var(--mono)" }}>Last 7 Days — {label}</div>
                {recent.length === 0 && <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic" }}>No data yet</div>}
                {recent.map(e => <MiniBar key={e.date + key} produced={e[`${key}_produced`]} target={e[`${key}_target`]} capacity={e[`${key}_capacity`] || e[`${key}_target`]} label={`${formatDate(e.date)} · ${e.product}`} color={color} hasNote={!!e.notes} />)}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ padding: "18px 22px 80px", position: "relative", zIndex: 1 }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 11, minWidth: 950 }}>
              <thead><tr style={{ borderBottom: `1px solid ${T.borderStrong}` }}>
                {["Date", "Product", "L1 Prod", "L1 Tgt", "L1 Cap", "L1 Tgt%", "L1 Cap%", "L2 Prod", "L2 Tgt", "L2 Cap", "L2 Tgt%", "L2 Cap%", "Total", "Notes", ""].map(h => (
                  <th key={h} style={{ padding: "8px 7px", textAlign: h === "Notes" ? "left" : "right", fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", color: T.textLight, fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {[...data].sort((a, b) => b.date.localeCompare(a.date)).map((e, i, arr) => {
                  const isToday = e.date === todayDateStr;
                  const isL = !isToday && e.date === (arr.find(r => r.date !== todayDateStr)?.date);
                  return (
                    <tr key={e.date} style={{ borderBottom: `1px solid ${T.border}`, background: isToday ? T.gaugeInnerBg : isL ? T.tealBg : "transparent" }}>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: isToday ? T.gold : isL ? T.teal : T.textMid, fontWeight: (isL || isToday) ? 600 : 400, whiteSpace: "nowrap" }}>
                        {formatDay(e.date)}
                        {isToday && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", borderRadius: 3, background: T.gold, color: "#fff", letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 700 }}>In progress</span>}
                      </td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.textLight }}>{e.product}</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.teal, fontWeight: 600 }}>{fmt(e.line1_produced)}</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.textFaint }}>{fmt(e.line1_target)}</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.textFaint }}>{fmt(e.line1_capacity)}</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: Number(pc(e.line1_produced, e.line1_target)) >= 50 ? T.teal : T.coral }}>{pc(e.line1_produced, e.line1_target)}%</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.textMid }}>{pc(e.line1_produced, e.line1_capacity)}%</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.coral, fontWeight: 600 }}>{fmt(e.line2_produced)}</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.textFaint }}>{fmt(e.line2_target)}</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.textFaint }}>{fmt(e.line2_capacity)}</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: Number(pc(e.line2_produced, e.line2_target)) >= 50 ? T.teal : T.coral }}>{pc(e.line2_produced, e.line2_target)}%</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.textMid }}>{pc(e.line2_produced, e.line2_capacity)}%</td>
                      <td style={{ padding: "7px 7px", textAlign: "right", color: T.text, fontWeight: 700 }}>{fmt(eTotal(e))}</td>
                      <td style={{ padding: "7px 7px", textAlign: "left", color: T.textFaint, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{e.notes || "—"}</td>
                      <td style={{ padding: "7px 7px", textAlign: "right" }}>{userRole && userRole !== "viewer" && <button onClick={() => openEntry(e.date)} title="Edit entry" style={{ background: "none", border: `1px solid ${T.borderStrong}`, color: T.teal, cursor: "pointer", fontSize: 11, padding: "3px 8px", borderRadius: 4, fontFamily: "var(--mono)" }}>Edit</button>}</td>
                    </tr>
                  );
                })}
                {data.length === 0 && <tr><td colSpan={15} style={{ padding: 36, textAlign: "center", color: T.textFaint }}>No entries yet. Tap +ADD to start.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: "5px 22px", display: "flex", justifyContent: "space-between", fontSize: 11, color: T.textFaint, fontFamily: "var(--mono)", background: T.footerBg, zIndex: 10, borderTop: `1px solid ${T.border}` }}>
        <span>Auto-refresh: 30s</span>
        <span>{data.length} entries</span>
      </div>
    </div>
  );
}
