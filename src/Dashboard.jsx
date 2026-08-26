import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./lib/supabase";
import CommentsModal, { CommentsList } from "./Comments.jsx";
import DowntimeCard from "./Downtime.jsx";

const DEFAULT_FILLER_TARGET = "05:30";

// How far back a sync (and the poll that reads it) reaches. Counted in WORKING
// days, not calendar days — see recentWorkingDates.
const SYNC_DAYS = 3;

const trimTime = (t) => (t ? t.slice(0, 5) : null);

// rowToEntry builds a fixed-shape literal, so key order is stable and stringify
// is a sound equality check here. Used to keep state references identical when a
// poll comes back with the same numbers.
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const sameDateSet = (prev, rows) => {
  const next = rows || [];
  return prev.size === next.length && next.every(r => prev.has(r.entry_date));
};

// Overlay freshly-polled days onto the history already in state, newest first.
// Only dates present in `fresh` are replaced; everything older is left alone.
function mergeEntriesByDate(prev, fresh) {
  if (!fresh.length) return prev;
  const byDate = new Map(prev.map(e => [e.date, e]));
  for (const e of fresh) byDate.set(e.date, e);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

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

// The day's target is meant to be hit over a 20-hour run. Pace = fraction of
// that window elapsed since the filler start. A completed past day returns 1
// (full target expected); the live day returns elapsed-so-far / 20h.
const PACE_WINDOW_MIN = 20 * 60;
function paceFraction(dateStr, startTime, now) {
  if (!dateStr) return 1;
  const start = new Date(`${dateStr}T${startTime || "05:30"}:00`);
  const total = PACE_WINDOW_MIN * 60000;
  const todayProd = productionDateStr(now);
  if (dateStr < todayProd) return 1; // completed day → whole window elapsed
  if (dateStr > todayProd) return 0; // future — shouldn't happen
  return Math.max(0, Math.min(1, (now - start) / total));
}
// Cases you should have produced by now if evenly paced across the 20h window.
function expectedByNow(dateStr, startTime, target, now) {
  return target > 0 ? target * paceFraction(dateStr, startTime, now) : 0;
}

// All pace figures for one day: per-line + combined efficiency (produced vs.
// the CAPACITY you should have reached by now over the 20h run) and bottle
// throughput (per hr / per min). Expected is anchored to the last sync so it
// doesn't outrun a frozen produced count; a completed past day uses the full
// 20h window (efficiency = produced / capacity = the gauge's CAP number).
// `mode` decides where each line's 20h pace clock starts — and it anchors BOTH
// the efficiency % and the live bottle rate (/hr · /min) so the two always
// agree. "target": start from the target filler time (a late-starting line
// reads as behind, not artificially ahead). "scan": start from the actual
// first-scan time (rate/efficiency reflect only the time the line has truly run).
function paceStats(entry, dateStr, now, mode = "target") {
  const p1 = entry?.line1_produced || 0, p2 = entry?.line2_produced || 0;
  const c1 = entry?.line1_capacity || 0, c2 = entry?.line2_capacity || 0;
  const rawSync = entry?.last_synced_at ? new Date(entry.last_synced_at) : null;
  const refTime = (rawSync && productionDateStr(rawSync) === dateStr) ? rawSync : now;
  const start1 = mode === "scan"
    ? (entry?.line1_filler_start || entry?.line1_filler_target)
    : (entry?.line1_filler_target || entry?.line1_filler_start);
  const start2 = mode === "scan"
    ? (entry?.line2_filler_start || entry?.line2_filler_target)
    : (entry?.line2_filler_target || entry?.line2_filler_start);
  const frac1 = paceFraction(dateStr, start1, refTime);
  const frac2 = paceFraction(dateStr, start2, refTime);
  const exp1 = c1 * frac1, exp2 = c2 * frac2;
  const min1 = frac1 * PACE_WINDOW_MIN, min2 = frac2 * PACE_WINDOW_MIN;
  const rMin1 = min1 > 0 ? p1 / min1 : null, rMin2 = min2 > 0 ? p2 / min2 : null;
  const pTot = p1 + p2, expTot = exp1 + exp2;
  const rMinTot = (rMin1 || 0) + (rMin2 || 0) || null;
  return {
    c1, c2, p1, p2, pTot, expTot,
    eff1: exp1 > 0 ? (p1 / exp1) * 100 : null,
    eff2: exp2 > 0 ? (p2 / exp2) * 100 : null,
    effTot: expTot > 0 ? (pTot / expTot) * 100 : null,
    rMin1, rMin2, rMinTot,
    rHr1: rMin1 != null ? rMin1 * 60 : null,
    rHr2: rMin2 != null ? rMin2 * 60 : null,
    rHrTot: rMinTot != null ? rMinTot * 60 : null,
  };
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
function isWeekendStr(dateStr) {
  const dow = new Date(dateStr + "T12:00:00").getDay();
  return dow === 0 || dow === 6;
}
// Working days = weekdays that aren't marked off (public holiday / shutdown),
// so a plant closure on a Mon–Fri drops out of the month projection and the
// required-per-day rate.
function isWorkingDay(year, month, day, offDays) {
  const d = new Date(year, month, day);
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  return !(offDays && offDays.has(localDateStr(d)));
}
// The days a sync should refresh: today, then back over WORKING days only.
// Counting calendar days stranded Fridays — a Monday sync spent both of its
// look-back slots on Sat/Sun and never re-read Friday, so a warehouse
// correction filed on Monday was never pulled in (Aug 21 2026 sat wrong for
// four days this way). Today is always included, even on a weekend, since
// overtime still produces. Bounded so an all-off calendar can't spin forever.
function recentWorkingDates(offDays, count = SYNC_DAYS) {
  const today = productionDateStr(new Date());
  const dates = [today];
  const d = new Date(today + "T12:00:00");
  for (let guard = 0; dates.length < count && guard < 60; guard++) {
    d.setDate(d.getDate() - 1);
    if (isWorkingDay(d.getFullYear(), d.getMonth(), d.getDate(), offDays)) dates.push(localDateStr(d));
  }
  return dates;
}
function workingDaysInMonth(year, month, offDays) {
  const last = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let day = 1; day <= last; day++) if (isWorkingDay(year, month, day, offDays)) count++;
  return count;
}
function workingDaysRemaining(year, month, fromDay, offDays) {
  const last = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let day = fromDay; day <= last; day++) if (isWorkingDay(year, month, day, offDays)) count++;
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

// Efficiency gauge: arc + headline show pace efficiency (produced vs. the
// capacity you should have reached by now over 20h), with the live bottle rate
// (/hr · /min) beneath. One number per line — no duplicate CAP/TGT readouts.
function DualGauge({ eff, rHr, rMin, label, colorA, size = 115 }) {
  const arc = eff == null ? 0 : Math.min(Math.max(eff, 0) / 100, 1);
  const r1 = (size - 16) / 2, circ1 = Math.PI * r1, cy = size / 2 + 4;
  return (
    <div style={{ textAlign: "center" }}>
      <svg width={size} height={size / 2 + 24} viewBox={`0 0 ${size} ${size / 2 + 24}`}>
        <path d={`M 8,${cy} A ${r1},${r1} 0 0 1 ${size - 8},${cy}`} fill="none" stroke={T.gaugeBg} strokeWidth="9" strokeLinecap="round" />
        <path d={`M 8,${cy} A ${r1},${r1} 0 0 1 ${size - 8},${cy}`} fill="none" stroke={colorA} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={circ1} strokeDashoffset={circ1 - arc * circ1} style={{ transition: "stroke-dashoffset 1.2s ease" }} />
        <text x={size / 2} y={cy - 3} textAnchor="middle" fill={perfColor(eff)} fontSize="27" fontWeight="800" fontFamily="var(--mono)">{eff == null ? "—" : Math.round(eff) + "%"}</text>
      </svg>
      <div style={{ fontSize: 13, color: "#000", fontFamily: "var(--mono)", fontWeight: 700, marginTop: 0 }}>
        {rHr == null ? "—" : `${fmt(Math.round(rHr))}/hr · ${rMin.toFixed(1)}/min`}
      </div>
      <div style={{ fontSize: 13, color: T.text, marginTop: 7, letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "var(--mono)", fontWeight: 700 }}>{label}</div>
    </div>
  );
}

// Plant UTC offset in minutes straight off a backend ISO string (…-04:00).
function isoOffsetMin(iso) {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso || "");
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}
// Absolute minutes on the PLANT clock. Absolute (not mod-24h) so the 5 AM hour
// at each end of the 05:30→05:30 window stays two separate columns; shifted into
// plant time so clock boundaries land on :00/:15/:30 regardless of the viewer's
// browser timezone.
function plantMin(iso, offMin) { return iso ? Math.round(Date.parse(iso) / 60000) + offMin : null; }
function minToHHMM(t) {
  const x = ((t % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
}

// Step a YYYY-MM-DD by whole days. Anchored at noon so a DST change can't
// bump the result onto the wrong date.
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000);
}

// Day picker for everything below it: prev/next arrows for walking days one at a
// time, a calendar for jumping, and a Today shortcut. Never goes past the
// current production day — there's nothing to show there.
function DateNav({ date, onChange, maxDate, hasData }) {
  if (!date) return null;
  const atToday = date === maxDate;
  const back = daysBetween(date, maxDate);
  const step = (n) => { const v = addDays(date, n); if (v <= maxDate) onChange(v); };
  const btn = (disabled) => ({
    display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 12px",
    background: disabled ? "transparent" : T.inputBg, border: `1px solid ${T.inputBorder}`,
    borderRadius: 6, color: disabled ? T.textFaint : T.text, fontFamily: "var(--mono)",
    fontSize: 12, fontWeight: 600, cursor: disabled ? "default" : "pointer", whiteSpace: "nowrap",
  });
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "10px 14px",
      marginBottom: 18, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <button type="button" onClick={() => step(-1)} style={btn(false)} title="Previous day">‹ Prev</button>
      <div style={{ textAlign: "center", minWidth: 190 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T.text, fontFamily: "var(--mono)" }}>
          {new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
        </div>
        <div style={{ fontSize: 10, color: atToday ? T.teal : T.textMid, fontFamily: "var(--mono)", marginTop: 2 }}>
          {atToday ? "Today · live" : back === 1 ? "Yesterday" : `${back} days ago`}
          {!hasData && <span style={{ color: T.gold }}> · nothing logged</span>}
        </div>
      </div>
      <button type="button" onClick={() => step(1)} disabled={atToday} style={btn(atToday)} title="Next day">Next ›</button>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
        <input type="date" value={date} max={maxDate}
          onChange={e => { const v = e.target.value; if (v && v <= maxDate) onChange(v); }}
          style={{ background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 6, color: T.text,
            padding: "6px 9px", fontSize: 12, fontFamily: "var(--mono)", outline: "none", cursor: "pointer" }} />
        <button type="button" onClick={() => onChange(maxDate)} disabled={atToday} style={btn(atToday)}>Today</button>
      </div>
    </div>
  );
}

// Finest grain we ask the backend for; every view is rolled up from it.
const RAW_BUCKET_MIN = 15;

// Shift 1 starts 06:00 and every shift is 10 hours, so Shift 1 = 6 AM–4 PM and
// Shift 2 = 4 PM–2 AM. The two blocks together are exactly the 20h window the
// pace gauges use, which is why a shift's capacity is half the line's rated
// daily capacity.
const SHIFT_START_MIN = 6 * 60;
const SHIFT_LEN_MIN = 10 * 60;

// One shift's panel: cases made, how much of the shift's capacity that used,
// the per-line split, and what ran. An unfinished shift is judged only against
// the minutes elapsed so far, never the full 10h.
function ShiftPanel({ shift, openMin, capPerMin, lines, running }) {
  const cap = lines.reduce((s, L) => s + capPerMin(L.key) * openMin, 0);
  const pct = cap > 0 ? Math.round((shift.total / cap) * 100) : null;
  const rate = openMin > 0 ? shift.total / (openMin / 60) : null;
  const bestHr = [...shift.hours.entries()].sort((a, b) => b[1] - a[1])[0];
  // One row per line, in the same order as the line rows above — the grouping
  // says which line it was, so the rows don't need an L1/L2 label.
  const prodRows = lines
    .map(L => [...(shift.prods[L.key] || new Map()).entries()].sort((a, b) => b[1] - a[1]))
    .filter(r => r.length > 0);
  const notStarted = openMin === 0;
  return (
    <div style={{ border: `1px solid ${running ? T.teal : T.border}`, borderRadius: 10, padding: "12px 14px",
      background: running ? T.tealBg : T.gaugeInnerBg }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", fontFamily: "var(--mono)", color: T.text }}>
          {shift.label}
        </span>
        <span style={{ fontSize: 10, color: T.textMid, fontFamily: "var(--mono)" }}>
          {shift.window}{running ? " · running" : ""}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 24, fontWeight: 800, fontFamily: "var(--mono)", color: T.text }}>{fmt(shift.total)}</span>
        <span style={{ fontSize: 11, color: T.textMid }}>cases</span>
        {pct != null && (
          <span style={{ marginLeft: "auto", fontSize: 16, fontWeight: 800, fontFamily: "var(--mono)", color: perfColor(pct) }}
            title={`${fmt(shift.total)} of ${fmt(Math.round(cap))} possible in ${running ? "the hours run so far" : "this shift"}`}>
            {pct}%
          </span>
        )}
      </div>
      {notStarted ? (
        <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic" }}>Hasn't started yet.</div>
      ) : (
        <>
          {lines.map(L => {
            const made = L.key === "1" ? shift.L1 : shift.L2;
            const lc = capPerMin(L.key) * openMin;
            const lp = lc > 0 && made > 0 ? Math.round((made / lc) * 100) : null;
            return (
              <div key={L.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: "var(--mono)", marginBottom: 3 }}
                title={`${L.label}: ${fmt(made)}${lc > 0 ? ` of ${fmt(Math.round(lc))} possible` : ""}`}>
                <span style={{ width: 9, height: 9, background: L.color, borderRadius: 2, flex: "0 0 auto" }} />
                <span style={{ color: T.textMid }}>{L.label}</span>
                <b style={{ color: L.color, marginLeft: "auto" }}>{fmt(made)}</b>
                <span style={{ color: lp != null ? perfColor(lp) : T.textFaint, width: 34, textAlign: "right" }}>{lp != null ? `${lp}%` : "—"}</span>
              </div>
            );
          })}
          <div style={{ fontSize: 10, color: T.textMid, fontFamily: "var(--mono)", marginTop: 7 }}>
            {rate != null ? `${fmt(Math.round(rate))} cases/hr` : "—"}
            {bestHr ? ` · best hour ${formatTime12(minToHHMM(bestHr[0]))} (${fmt(bestHr[1])})` : ""}
          </div>
          {prodRows.length > 0 && (
            <div style={{ fontSize: 11, color: "#000", fontWeight: 600, marginTop: 5, lineHeight: 1.5 }}>
              {prodRows.map((row, i) => (
                <div key={i}>{row.map(([n, c]) => `${n} ${fmt(c)}`).join(" · ")}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Today's per-product breakdown + a time-bucketed (60/30/15-min) case timeline,
// pulled live from the inventory backend via the `production-detail` edge
// function. Answers "what are we making today" and "which window was slow".
function ProductionDetail({ date, isToday, caps }) {
  const [bucket, setBucket] = useState(60);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // Always pull the FINEST grain (15 min) and roll it up on the client. The
  // backend buckets from 05:30, so its 60-min buckets run 5:30–6:30; its 15-min
  // buckets land on :00/:15/:30/:45, which we can re-bucket onto real clock
  // hours (6–7, 7–8, …). Also means switching 1hr/30/15 needs no refetch.
  //
  // The inventory API behind this endpoint does blip — when it does it can hang
  // until Cloudflare 502s it ~47s later. So: cap each attempt at 20s, retry
  // twice quietly, and on give-up keep whatever was last loaded on screen with a
  // warning instead of blanking the card.
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    let retryTimer = null;
    const run = async (attempt) => {
      const ctrl = new AbortController();
      const bail = setTimeout(() => ctrl.abort(), 20000);
      let res = null, error = null;
      try {
        const out = await supabase.functions.invoke("production-detail", {
          body: { date, bucket_minutes: RAW_BUCKET_MIN }, signal: ctrl.signal,
        });
        res = out.data; error = out.error || res?.error || null;
      } catch (e) { error = e; }
      clearTimeout(bail);
      if (cancelled) return;
      if (!error) { setData(res); setErr(null); setRetrying(false); setLoading(false); return; }
      if (attempt < 2) { setRetrying(true); retryTimer = setTimeout(() => run(attempt + 1), 4000); return; }
      const msg = typeof error === "string" ? error : error?.message || "couldn't reach the inventory API";
      setErr(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
      setRetrying(false); setLoading(false);
    };
    setLoading(true); setErr(null); setRetrying(false);
    run(0);
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [date, isToday, reloadTick]);

  // Roll the per-(line,product) rows up to one entry per product.
  const products = (() => {
    const m = new Map();
    for (const p of data?.products || []) {
      const key = p.product_name || p.short_code || p.product_id || "Unknown";
      const cur = m.get(key) || { name: key, cases: 0, lines: new Set() };
      cur.cases += p.cases || 0;
      if (p.line_number) cur.lines.add(p.line_number);
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.cases - a.cases);
  })();

  // --- Clock-aligned buckets -------------------------------------------------
  // Columns are real clock windows (6–7, 7–8, …), NOT offsets from the backend's
  // 05:30 window start. The run is the two 10h shifts — 6 AM → 2 AM, exactly the
  // 20h the capacity is rated over — so every column is a whole hour worth of
  // capacity. Columns extend past that only where something was actually
  // scanned; the ends are never padded with empty ones.
  const off = isoOffsetMin(data?.window_start);
  const winS = plantMin(data?.window_start, off);
  const winE = plantMin(data?.window_end, off);
  const nowM = plantMin(data?.as_of, off);

  const buckets = (() => {
    if (winS == null || winE == null || winE <= winS) return [];
    // Bucket every row first, so the span can be widened to cover stray scans.
    const hit = new Map();
    for (const r of data?.timeline || []) {
      const slot = Math.floor(plantMin(r.bucket_start, off) / bucket);
      const e = hit.get(slot) || { L1: 0, L2: 0, total: 0 };
      const c = r.cases || 0;
      if (r.line_number === "1") e.L1 += c; else if (r.line_number === "2") e.L2 += c;
      e.total += c;
      hit.set(slot, e);
    }
    const runStart = Math.floor(winS / 1440) * 1440 + SHIFT_START_MIN; // 06:00
    const runEnd = runStart + 2 * SHIFT_LEN_MIN;                       // 02:00 next day
    let first = Math.floor(runStart / bucket), last = Math.ceil(runEnd / bucket) - 1;
    for (const s of hit.keys()) { first = Math.min(first, s); last = Math.max(last, s); }
    const out = [];
    for (let s = first; s <= last; s++) {
      const bs = s * bucket, e = hit.get(s);
      out.push({
        idx: s - first, slot: s, startMin: bs, endMin: bs + bucket,
        hhmm: minToHHMM(bs), endHHMM: minToHHMM(bs + bucket),
        L1: e?.L1 || 0, L2: e?.L2 || 0, total: e?.total || 0,
      });
    }
    return out;
  })();

  const LINES = [
    { key: "1", label: "Line I", color: T.teal },
    { key: "2", label: "Line II", color: T.coral },
  ];
  const dayProd = { "1": 0, "2": 0 };
  buckets.forEach(b => { dayProd["1"] += b.L1; dayProd["2"] += b.L2; });
  // Capacity per minute of the 20h run (same window the pace gauges use).
  const capPerMin = (k) => (caps?.[k] || 0) / PACE_WINDOW_MIN;
  // Show every line with capacity or production — an idle line still appears as
  // an empty gray capacity slot, so you can see it didn't run.
  let shownLines = LINES.filter(L => capPerMin(L.key) > 0 || dayProd[L.key] > 0);
  if (!shownLines.length) shownLines = LINES;
  const hasCap = shownLines.some(L => capPerMin(L.key) > 0);

  // A window is "current" while now sits inside it and the day is still running.
  const isCurrent = (b) => nowM != null && nowM >= b.startMin && nowM < b.endMin && nowM < winE;
  const isComplete = (b) => nowM == null || b.endMin <= nowM || nowM >= winE;
  // Minutes of this window the plant could actually have been producing in:
  // clipped to the production window, and to "now" for the in-progress one.
  const openMin = (b) => {
    const lo = Math.max(b.startMin, winS);
    let hi = Math.min(b.endMin, winE);
    if (nowM != null && nowM < hi) hi = Math.max(lo, nowM);
    return Math.max(0, hi - lo);
  };
  // Gray ceiling = everything this window could hold (so future hours still show
  // their slot); the % denominator only counts minutes already elapsed.
  const capFull = (b, k) => capPerMin(k) * Math.max(0, Math.min(b.endMin, winE) - Math.max(b.startMin, winS));
  const capSoFar = (b, k) => capPerMin(k) * openMin(b);

  // Scale bar heights by the tallest produced value or full-window capacity so
  // the gray capacity "ceiling" and the solid "made" fill are comparable.
  const maxBar = Math.max(1, ...buckets.map(b => Math.max(b.L1, b.L2)), ...shownLines.map(L => capPerMin(L.key) * bucket));

  // Best / worst over COMPLETE windows only (skip the in-progress current hour
  // and anything future).
  const activeIdxs = buckets.filter(b => b.total > 0).map(b => b.idx);
  const span = activeIdxs.length
    ? buckets.filter(b => b.idx >= Math.min(...activeIdxs) && b.idx <= Math.max(...activeIdxs) && isComplete(b))
    : [];
  const peak = span.length ? span.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  const slow = span.length ? span.reduce((a, b) => (b.total < a.total ? b : a)) : null;
  const totalCases = products.reduce((s, p) => s + p.cases, 0);
  // The bars come from timestamped pallet scans; the product chips come from the
  // day's pallet totals. Some pallets reach the backend with no usable scan time,
  // so the bars can add up to LESS than the chips — say so instead of letting the
  // two numbers silently disagree.
  const barCases = dayProd["1"] + dayProd["2"];
  const untimed = Math.max(0, totalCases - barCases);

  // --- Shift 1 / Shift 2 -----------------------------------------------------
  // Built from the same 15-min rows as the bars. Each shift is RATED for 10h
  // (6 AM–4 PM, 4 PM–2 AM) but COLLECTS wider than that, so the two together
  // cover the whole 05:30→05:30 production day and no scan is ever orphaned:
  // Shift 2 keeps anything its crew scans past 2 AM (overtime / late close-out),
  // and Shift 1 likewise picks up a start before 6 AM. Capacity stays the rated
  // 10h, so overtime reads as a real over-100% instead of quietly vanishing.
  const shiftSplit = (() => {
    if (winS == null || winE == null) return null;
    const midnight = Math.floor(winS / 1440) * 1440; // 00:00 of the window's own day
    const s1Start = midnight + SHIFT_START_MIN;
    const s2Start = s1Start + SHIFT_LEN_MIN;
    const s2End = s2Start + SHIFT_LEN_MIN;
    const mk = (label, nomStart, nomEnd, binStart, binEnd) => ({
      label, nomStart, nomEnd, binStart, binEnd,
      window: `${formatTime12(minToHHMM(nomStart))}–${formatTime12(minToHHMM(nomEnd))}`,
      L1: 0, L2: 0, total: 0, prods: { "1": new Map(), "2": new Map() }, hours: new Map(),
    });
    const list = [
      mk("Shift 1", s1Start, s2Start, Math.min(winS, s1Start), s2Start),
      mk("Shift 2", s2Start, s2End, s2Start, Math.max(winE, s2End)),
    ];
    for (const r of data?.timeline || []) {
      const m = plantMin(r.bucket_start, off);
      const s = list.find(x => m >= x.binStart && m < x.binEnd) || list[1];
      const c = r.cases || 0;
      if (r.line_number === "1") s.L1 += c; else if (r.line_number === "2") s.L2 += c;
      s.total += c;
      // Kept per line, so each line's products list on its own row.
      const pn = r.product_name || r.short_code || "Unknown";
      const pm = s.prods[r.line_number];
      if (pm) pm.set(pn, (pm.get(pn) || 0) + c);
      const hr = Math.floor(m / 60) * 60;
      s.hours.set(hr, (s.hours.get(hr) || 0) + c);
    }
    return { list };
  })();
  // Minutes of a shift the plant could have been producing in — the RATED 10h,
  // clipped to the production window and to "now" for a shift still under way.
  const shiftOpenMin = (s) => {
    const lo = Math.max(s.nomStart, winS);
    let hi = Math.min(s.nomEnd, winE);
    if (nowM != null && nowM < hi) hi = Math.max(lo, nowM);
    return Math.max(0, hi - lo);
  };
  // "Running" spans the collecting window, so a crew still scanning at 3 AM
  // still reads as on shift.
  const shiftRunning = (s) => nowM != null && nowM >= s.binStart && nowM < s.binEnd && nowM < winE;

  // Never hide the card on an error — a card that vanishes reads as "the feature
  // broke" and hides the fact that the inventory API is the thing that's down.

  const rangeLabel = (b) => b ? `${formatTime12(b.hhmm)}–${formatTime12(b.endHHMM)}` : "—";

  return (
    <>
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>
          {isToday ? "Producing Today" : "Products This Day"}
          {totalCases > 0 && <span style={{ color: T.textMid, fontWeight: 600, textTransform: "none", letterSpacing: 0 }}> · {fmt(totalCases)} cases</span>}
        </div>
        <div style={{ display: "inline-flex", border: `1px solid ${T.inputBorder}`, borderRadius: 5, overflow: "hidden", fontFamily: "var(--mono)", fontSize: 11 }} title="Time-bucket width for the drill-down">
          {[60, 30, 15].map(m => (
            <button key={m} type="button" onClick={() => setBucket(m)}
              style={{ padding: "5px 10px", border: "none", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11,
                background: bucket === m ? T.text : "transparent", color: bucket === m ? T.bg : T.textMid, fontWeight: bucket === m ? 700 : 500 }}>
              {m === 60 ? "1 hr" : `${m} min`}
            </button>
          ))}
        </div>
      </div>

      {/* Product chips */}
      {products.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {products.map(p => (
            <div key={p.name} style={{ display: "flex", alignItems: "baseline", gap: 7, background: T.tealBg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 11px" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{p.name}</span>
              <span style={{ fontSize: 14, fontWeight: 800, color: T.teal, fontFamily: "var(--mono)" }}>{fmt(p.cases)}</span>
              <span style={{ fontSize: 10, color: T.textMid, fontFamily: "var(--mono)" }}>L{[...p.lines].sort().join("+") || "?"}</span>
            </div>
          ))}
        </div>
      )}

      {loading && (
        <div style={{ fontSize: 11, color: retrying ? T.gold : T.textFaint, fontStyle: "italic", padding: "8px 0" }}>
          {retrying ? "Inventory API isn't answering — retrying…" : "Loading live production…"}
        </div>
      )}
      {err && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 11px", marginBottom: 10,
          background: T.coralBg, border: `1px solid ${T.border}`, borderRadius: 8 }}>
          <span style={{ fontSize: 11, color: T.text, lineHeight: 1.45 }}>
            <b style={{ color: T.coral }}>Can't reach the inventory API.</b>{" "}
            {data ? "Showing the last numbers that loaded — they may be behind." : "The hourly and shift breakdowns need it; the totals above come from the last sync."}
            <span style={{ color: T.textMid }}> ({err})</span>
          </span>
          <button type="button" onClick={() => setReloadTick(t => t + 1)}
            style={{ marginLeft: "auto", padding: "5px 11px", borderRadius: 5, border: `1px solid ${T.inputBorder}`, background: "transparent",
              color: T.text, fontSize: 11, fontWeight: 700, fontFamily: "var(--mono)", cursor: "pointer", whiteSpace: "nowrap" }}>
            Retry
          </button>
        </div>
      )}

      {!loading && !err && buckets.length === 0 && (
        <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic", padding: "8px 0" }}>No scanned pallets to break down yet for this day.</div>
      )}

      {/* Full production day (05:30 → next-day 05:30), one column per window.
          Big % (green→red) = share of the running line's capacity used; gray =
          capacity, colored fill = made. Idle/empty hours show neutral. */}
      {buckets.length > 0 && (
        <>
          {hasCap && (
            <div style={{ fontSize: 11, color: T.textMid, marginBottom: 10, lineHeight: 1.4 }}>
              The run is <b style={{ color: T.text }}>6 AM → 2 AM</b> — two 10 h shifts, the same 20 h the capacity is rated over — so each bar is {bucket === 60 ? "one clock hour (6–7, 7–8, …) worth" : `${bucket} min`} of capacity, one bar per line. The number under each bar is what <b style={{ color: T.text }}>that line</b> made; the <b style={{ color: T.text }}>%</b> above it is how much of that line's capacity it used —{" "}
              <span style={{ color: T.teal, fontWeight: 700 }}>green = strong</span>,{" "}
              <span style={{ color: T.gold, fontWeight: 700 }}>amber = watch</span>,{" "}
              <span style={{ color: T.coral, fontWeight: 700 }}>red = slow</span>. Gray = full capacity.
            </div>
          )}
          {untimed > 0 && (
            <div style={{ fontSize: 11, color: T.gold, marginBottom: 10, lineHeight: 1.4 }}>
              Bars add up to <b>{fmt(barCases)}</b> of the day's <b>{fmt(totalCases)}</b> cases — {fmt(untimed)} came through without a scan time, so they're in the product totals above but not in any hour below.
            </div>
          )}
          <div style={{ display: "flex", alignItems: "flex-end", gap: bucket === 60 ? 8 : 4, overflowX: "auto", paddingBottom: 4 }}>
            {buckets.map(b => {
              const cur = isCurrent(b);
              const isSlow = !cur && slow && b.idx === slow.idx;
              const isPeak = !cur && peak && b.idx === peak.idx;
              const barW = bucket === 15 ? 10 : bucket === 30 ? 14 : 22;
              const showLbl = bucket === 60 || b.startMin % 60 === 0;
              const H = 100;
              const cTime = (hhmm) => formatTime12(hhmm).replace(":00", "").replace(" AM", "a").replace(" PM", "p");
              return (
                <div key={b.idx} title={`${rangeLabel(b)}${cur ? " (in progress)" : ""} — made ${fmt(b.total)} cases${shownLines.length > 1 ? ` (L1 ${fmt(b.L1)} + L2 ${fmt(b.L2)})` : ""}`}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "0 0 auto",
                    padding: "3px 3px", borderRadius: 6,
                    background: isSlow ? "rgba(217,74,66,0.08)" : isPeak ? "rgba(14,153,144,0.08)" : cur ? "rgba(14,153,144,0.05)" : "transparent" }}>
                  {/* each LINE its own bar with its own % above it (green→red = that line's capacity used) */}
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 2 }}>
                    {shownLines.map(L => {
                      const prod = L.key === "1" ? b.L1 : b.L2;
                      const cap = capSoFar(b, L.key), capMax = capFull(b, L.key);
                      const lu = (prod > 0 && cap > 0) ? Math.round((prod / cap) * 100) : null;
                      const ph = prod > 0 ? Math.max(3, (prod / maxBar) * H) : 0;
                      const ch = capMax > 0 ? (capMax / maxBar) * H : 0;
                      return (
                        <div key={L.key} title={`${L.label} ${rangeLabel(b)}${cur ? " (in progress)" : ""}: made ${fmt(prod)}${cap > 0 ? ` of ${fmt(Math.round(cap))} possible${cur ? " so far" : ""} (${lu ?? 0}%)` : ""}`}
                          style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end" }}>
                          {bucket === 60 && (
                            <div style={{ fontSize: 10, fontWeight: 800, fontFamily: "var(--mono)", color: lu != null ? perfColor(lu) : T.textFaint, height: 16, lineHeight: "16px", opacity: cur ? 0.7 : 1 }}>
                              {lu != null ? `${lu}%` : ""}
                            </div>
                          )}
                          <div style={{ position: "relative", width: barW, height: H, display: "flex", alignItems: "flex-end" }}>
                            {ch > 0 && <div style={{ position: "absolute", bottom: 0, left: 0, width: barW, height: ch, background: T.gaugeBg, borderRadius: "3px 3px 0 0" }} />}
                            <div style={{ position: "relative", width: barW, height: ph, background: L.color, borderRadius: "3px 3px 0 0", opacity: cur ? 0.7 : 1 }} />
                          </div>
                          {/* cases made by THIS line in this window, in the line's own color */}
                          {bucket === 60 && (
                            <div style={{ fontSize: 9, fontWeight: 700, fontFamily: "var(--mono)", color: L.color, height: 11, opacity: cur ? 0.7 : 1 }}>
                              {prod > 0 ? fmt(prod) : ""}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* time window */}
                  <div style={{ fontSize: 9, color: cur ? T.teal : T.textMid, fontWeight: cur ? 700 : 400, fontFamily: "var(--mono)", marginTop: 3, whiteSpace: "nowrap", height: 11 }}>
                    {cur ? "now" : (showLbl ? cTime(b.hhmm) : "")}
                  </div>
                  {/* both lines running → spell out the combined figure so the
                      per-line numbers above are never mistaken for a total */}
                  {bucket === 60 && (
                    <div style={{ fontSize: 8, color: T.textLight, fontFamily: "var(--mono)", height: 10 }}>
                      {b.L1 > 0 && b.L2 > 0 ? `Σ ${fmt(b.total)}` : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10, fontSize: 11, fontFamily: "var(--mono)", color: T.textMid, alignItems: "center" }}>
            {shownLines.map(L => (
              <span key={L.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 10, height: 10, background: L.color, borderRadius: 2 }} /> {L.label} made <b style={{ color: L.color }}>{fmt(dayProd[L.key])}</b>
              </span>
            ))}
            {shownLines.length > 1 && <span>both lines <b style={{ color: T.text }}>{fmt(barCases)}</b></span>}
            {hasCap && <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 10, background: T.gaugeBg, borderRadius: 2 }} /> capacity</span>}
            {peak && <span style={{ color: T.teal }}>Best <b>{rangeLabel(peak)}</b> · {fmt(peak.total)} cases</span>}
            {slow && slow.idx !== peak?.idx && <span style={{ color: T.coral }}>Worst <b>{rangeLabel(slow)}</b> · {fmt(slow.total)} cases</span>}
          </div>
        </>
      )}
    </div>

    {/* Shift 1 (6 AM–4 PM) vs Shift 2 (4 PM–2 AM), from the same scan data. Stays
        on screen with zeros on a day with no scans — a card that disappears reads
        as a broken feature, not as an empty day. */}
    {shiftSplit && (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>
            Shift Split
            <span style={{ color: T.textMid, fontWeight: 600, textTransform: "none", letterSpacing: 0 }}>
              {barCases === 0 ? " · nothing scanned yet for this day"
                : untimed > 0 ? ` · ${fmt(barCases)} of ${fmt(totalCases)} cases placed`
                : ` · ${fmt(barCases)} cases`}
            </span>
          </div>
          <div style={{ fontSize: 10, color: T.textLight, fontFamily: "var(--mono)" }}>
            10h shift
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
          {shiftSplit.list.map(s => (
            <ShiftPanel key={s.label} shift={s} openMin={shiftOpenMin(s)} capPerMin={capPerMin}
              lines={shownLines} running={shiftRunning(s)} />
          ))}
        </div>
        {/* Shift is read from the scan time, so a pallet with no scan time can't
            be placed in one. Say the number plainly rather than implying it's
            pending something. */}
        {untimed > 0 && (
          <div style={{ fontSize: 11, color: T.gold, marginTop: 10, lineHeight: 1.5 }}>
            {fmt(untimed)} more cases have no scan time, so they can't be placed in a shift — the day's full total is {fmt(totalCases)}.
          </div>
        )}
      </div>
    )}
    </>
  );
}

// Per-day, per-line, per-product cases for a list of dates — fetched from the
// already-deployed `production-detail` endpoint (one call per day, in parallel),
// so no new backend endpoint is needed. Returns { date: { "1": [{name,cases}], "2": [...] } }.
function useDailyProducts(dates) {
  const key = (dates || []).filter(Boolean).join(",");
  const [byDate, setByDate] = useState({});
  useEffect(() => {
    const ds = key ? key.split(",") : [];
    if (!ds.length) { setByDate({}); return; }
    let cancelled = false;
    Promise.all(ds.map(d =>
      supabase.functions.invoke("production-detail", { body: { date: d } })
        .then(({ data: res, error }) => (error || res?.error) ? null : { d, products: res?.products || [] })
        .catch(() => null)
    )).then(results => {
      if (cancelled) return;
      const m = {};
      for (const r of results) {
        if (!r) continue;
        const by = { "1": [], "2": [] };
        for (const p of r.products) {
          if (!p.line_number || !by[p.line_number]) continue;
          by[p.line_number].push({ name: p.product_name || p.short_code || "Unknown", cases: p.cases || 0 });
        }
        for (const k of ["1", "2"]) by[k].sort((a, b) => b.cases - a.cases);
        m[r.d] = by;
      }
      setByDate(m);
    });
    return () => { cancelled = true; };
  }, [key]);
  return byDate;
}

// Working days (weekdays that aren't marked off) in [startStr,endStr] inclusive.
function workingDayList(startStr, endStr, offDays) {
  const out = [];
  if (!startStr || !endStr) return out;
  const d = new Date(startStr + "T12:00:00");
  const end = new Date(endStr + "T12:00:00");
  while (d <= end) {
    const dow = d.getDay();
    const ds = localDateStr(d);
    if (dow !== 0 && dow !== 6 && !(offDays && offDays.has(ds))) out.push(ds);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Production trend: this period vs last, aligned by WORKING DAY (weekends &
// holidays skipped on both sides, matched by position not date — so no
// Friday-vs-Sunday or open-vs-closed mismatches). Click a day → its products;
// pick a flavor → only its days light up + a list.
// Production trend. Two views:
//  • Compare — pick any two months (A vs B), aligned by WORKING DAY (weekends &
//    holidays skipped on both sides, matched by position). Click a day to see
//    BOTH months' numbers + flavors for that working day.
//  • History — monthly totals over the last 12 months, to see the macro trend.
function ProductionTrend({ data, now, offDays }) {
  const [view, setView] = useState("compare"); // "compare" | "history"
  const [flavor, setFlavor] = useState("");
  const [dayPanel, setDayPanel] = useState(null);

  const todayStr = productionDateStr(now);
  const yd = new Date(todayStr + "T12:00:00"); yd.setDate(yd.getDate() - 1);
  const yestStr = localDateStr(yd);
  const ymKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const ymLabel = (ym) => { const [Y, M] = ym.split("-").map(Number); return new Date(Y, M - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" }); };
  const curYm = ymKey(now);

  // Only offer months from the first month that actually has production back to
  // now — no empty pre-data months in the pickers or the history view.
  const producedDates = data.filter(e => (e.line1_produced || 0) + (e.line2_produced || 0) > 0).map(e => e.date).sort();
  const firstYm = producedDates.length ? producedDates[0].slice(0, 7) : curYm;
  const [fY, fM] = firstYm.split("-").map(Number);
  const monthsSpan = (now.getFullYear() - fY) * 12 + (now.getMonth() - (fM - 1)); // 0 = same month
  const monthOpts = [];
  for (let k = 0; k <= Math.min(monthsSpan, 35); k++) monthOpts.push(ymKey(new Date(now.getFullYear(), now.getMonth() - k, 1)));
  const [monthA, setMonthA] = useState(monthOpts[0]);
  const [monthB, setMonthB] = useState(monthOpts[1] || monthOpts[0]);

  const byDateMap = (() => { const m = new Map(); for (const e of data) m.set(e.date, e); return m; })();
  const totalOf = (ds) => { const e = byDateMap.get(ds); return e ? (e.line1_produced || 0) + (e.line2_produced || 0) : 0; };
  const capOf = (ds) => { const e = byDateMap.get(ds); return e ? (e.line1_capacity || 0) + (e.line2_capacity || 0) : 0; };

  // A month runs to yesterday if it's the current (in-progress) month, else to
  // its last day.
  const monthBounds = (ym) => {
    const [Y, M] = ym.split("-").map(Number);
    const start = localDateStr(new Date(Y, M - 1, 1));
    const end = ym === curYm ? yestStr : localDateStr(new Date(Y, M, 0));
    return [start, end];
  };
  const monthRows = (ym) => { const [s, e] = monthBounds(ym); return workingDayList(s, e, offDays).map(ds => ({ date: ds, total: totalOf(ds), cap: capOf(ds) })); };

  const aRows = monthRows(monthA);
  const bRows = monthRows(monthB);

  // Flavor breakdown for month A (per-day fetch; used for the flavor filter).
  const products = useDailyProducts(view === "compare" ? aRows.map(r => r.date) : []);
  const dayProducts = (ds) => { const p = products[ds]; const all = []; if (p) for (const k of ["1", "2"]) for (const it of p[k]) all.push(it); return all; };
  const flavorSet = new Set();
  for (const r of aRows) for (const it of dayProducts(r.date)) if (it.cases > 0) flavorSet.add(it.name);
  const flavorOptions = [...flavorSet].sort();
  const flavorCasesOn = (ds, name) => dayProducts(ds).reduce((s, it) => s + (it.name === name ? it.cases : 0), 0);
  const flavorDays = flavor ? aRows.filter(r => flavorCasesOn(r.date, flavor) > 0) : [];

  // History: monthly totals for the last 12 months.
  const history = [];
  for (let k = Math.min(11, monthsSpan); k >= 0; k--) {
    const ym = ymKey(new Date(now.getFullYear(), now.getMonth() - k, 1));
    const [s, e] = monthBounds(ym);
    const wds = workingDayList(s, e, offDays);
    history.push({ ym, label: ymLabel(ym), total: wds.reduce((t, ds) => t + totalOf(ds), 0), cap: wds.reduce((t, ds) => t + capOf(ds), 0), wd: wds.length });
  }

  // Click a working-day index → both months' numbers (stored) + flavors (fetched).
  const openDay = (i) => {
    const a = aRows[i], b = bRows[i];
    setDayPanel({ i, aDate: a?.date || null, bDate: b?.date || null, aTotal: a?.total || 0, bTotal: b?.total || 0, aProds: null, bProds: null, loading: true });
    const grp = (res) => { const by = { "1": [], "2": [] }; const ps = res?.data?.products || []; for (const p of ps) { if (p.line_number && by[p.line_number]) by[p.line_number].push({ name: p.product_name || p.short_code || "Unknown", cases: p.cases || 0 }); } for (const k of ["1", "2"]) by[k].sort((x, z) => z.cases - x.cases); return by; };
    Promise.all([
      a?.date ? supabase.functions.invoke("production-detail", { body: { date: a.date } }) : Promise.resolve(null),
      b?.date ? supabase.functions.invoke("production-detail", { body: { date: b.date } }) : Promise.resolve(null),
    ]).then(([ra, rb]) => setDayPanel(d => (d && d.i === i) ? { ...d, aProds: grp(ra), bProds: grp(rb), loading: false } : d));
  };

  const W = 1000, H = 210, padL = 46, padR = 14, padT = 12, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const wdShort = (ds) => new Date(ds + "T12:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
  const wdFull = (ds) => new Date(ds + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  const nC = Math.max(aRows.length, bRows.length, 1);
  const yMaxC = Math.max(1, ...aRows.map(r => r.total), ...bRows.map(r => r.total), ...aRows.map(r => r.cap)) * 1.12;
  const XC = (i) => padL + (nC <= 1 ? plotW / 2 : (i / (nC - 1)) * plotW);
  const YC = (v) => padT + plotH - (v / yMaxC) * plotH;
  const pathC = (rows) => rows.map((r, i) => `${i === 0 ? "M" : "L"} ${XC(i).toFixed(1)} ${YC(r.total).toFixed(1)}`).join(" ");
  const avgCapA = aRows.length ? aRows.reduce((s, r) => s + r.cap, 0) / aRows.length : 0;
  const labelEvery = Math.max(1, Math.ceil(nC / 9));

  const nH = history.length;
  const yMaxH = Math.max(1, ...history.map(m => m.total), ...history.map(m => m.cap)) * 1.12;
  const XH = (i) => padL + (nH <= 1 ? plotW / 2 : (i / (nH - 1)) * plotW);
  const YH = (v) => padT + plotH - (v / yMaxH) * plotH;
  const pathH = history.map((m, i) => `${i === 0 ? "M" : "L"} ${XH(i).toFixed(1)} ${YH(m.total).toFixed(1)}`).join(" ");

  const aTotal = aRows.reduce((s, r) => s + r.total, 0);
  const bCum = bRows.slice(0, aRows.length).reduce((s, r) => s + r.total, 0);
  const delta = bCum > 0 ? ((aTotal - bCum) / bCum) * 100 : null;

  const yTicks = (Ymax, Yf) => [0, 0.5, 1].map(f => { const v = Ymax * f; return (
    <g key={f}>
      <line x1={padL} x2={W - padR} y1={Yf(v)} y2={Yf(v)} stroke={T.border} strokeWidth="1" />
      <text x={padL - 6} y={Yf(v) + 3} textAnchor="end" fontSize="10" fill={T.textLight} fontFamily="var(--mono)">{fmt(Math.round(v))}</text>
    </g>); });

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>
          Production Trend <span style={{ color: T.textMid, fontWeight: 600, textTransform: "none", letterSpacing: 0 }}>· {view === "compare" ? `${ymLabel(monthA)} vs ${ymLabel(monthB)}` : "Last 12 months"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", border: `1px solid ${T.inputBorder}`, borderRadius: 5, overflow: "hidden", fontFamily: "var(--mono)", fontSize: 11 }}>
            {[["compare", "Compare"], ["history", "12-month"]].map(([v, l]) => (
              <button key={v} type="button" onClick={() => { setView(v); setDayPanel(null); }}
                style={{ padding: "5px 10px", border: "none", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, background: view === v ? T.text : "transparent", color: view === v ? T.bg : T.textMid, fontWeight: view === v ? 700 : 500 }}>{l}</button>
            ))}
          </div>
          {view === "compare" && (
            <>
              <select value={monthA} onChange={e => { setMonthA(e.target.value); setDayPanel(null); setFlavor(""); }} style={{ background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 5, color: T.teal, fontWeight: 700, padding: "5px 8px", fontSize: 11, fontFamily: "var(--mono)", cursor: "pointer" }}>
                {monthOpts.map(ym => <option key={ym} value={ym}>{ymLabel(ym)}</option>)}
              </select>
              <span style={{ fontSize: 11, color: T.textMid }}>vs</span>
              <select value={monthB} onChange={e => { setMonthB(e.target.value); setDayPanel(null); }} style={{ background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 5, color: T.textMid, padding: "5px 8px", fontSize: 11, fontFamily: "var(--mono)", cursor: "pointer" }}>
                {monthOpts.map(ym => <option key={ym} value={ym}>{ymLabel(ym)}</option>)}
              </select>
              <select value={flavor} onChange={e => { setFlavor(e.target.value); setDayPanel(null); }} style={{ background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 5, color: T.text, padding: "5px 8px", fontSize: 11, fontFamily: "var(--mono)", cursor: "pointer", maxWidth: 220 }}>
                <option value="">All flavors</option>
                {flavorOptions.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </>
          )}
        </div>
      </div>

      {view === "compare" ? (
        <>
          <div style={{ fontSize: 11, color: T.textMid, marginBottom: 8 }}>
            Aligned by working day — weekends & holidays skipped both sides. <b style={{ color: T.teal }}>━ {ymLabel(monthA)}</b> · <span style={{ color: T.textLight }}>┈ {ymLabel(monthB)}</span> · click a point to compare that working day.
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", overflow: "visible" }}>
            {yTicks(yMaxC, YC)}
            {avgCapA > 0 && <line x1={padL} x2={W - padR} y1={YC(avgCapA)} y2={YC(avgCapA)} stroke={T.text} strokeWidth="1" strokeDasharray="4 4" opacity="0.5" />}
            {bRows.length > 1 && <path d={pathC(bRows)} fill="none" stroke={T.textLight} strokeWidth="2" strokeDasharray="3 3" opacity="0.7" />}
            {aRows.length > 1 && <path d={pathC(aRows)} fill="none" stroke={T.teal} strokeWidth="2.5" />}
            {aRows.map((r, i) => {
              const isFlavorDay = flavor ? flavorCasesOn(r.date, flavor) > 0 : true;
              const isSel = dayPanel && dayPanel.i === i;
              const rad = isSel ? 6 : (flavor && isFlavorDay ? 5 : 3.5);
              const fill = !isFlavorDay ? T.textFaint : (r.total > 0 ? perfColor(r.cap > 0 ? (r.total / r.cap) * 100 : 100) : T.textFaint);
              return (
                <g key={r.date} style={{ cursor: "pointer" }} onClick={() => openDay(i)}>
                  <circle cx={XC(i)} cy={YC(r.total)} r={12} fill="transparent" />
                  {isSel && <circle cx={XC(i)} cy={YC(r.total)} r={rad + 3} fill="none" stroke={T.text} strokeWidth="1.5" />}
                  <circle cx={XC(i)} cy={YC(r.total)} r={rad} fill={fill} opacity={isFlavorDay ? 1 : 0.4} />
                  <title>WD{i + 1} · {wdFull(r.date)}: {fmt(r.total)}{bRows[i] ? ` · ${ymLabel(monthB)} ${wdShort(bRows[i].date)}: ${fmt(bRows[i].total)}` : ""}</title>
                </g>
              );
            })}
            {aRows.map((r, i) => (i % labelEvery === 0 || i === aRows.length - 1) ? (
              <text key={r.date} x={XC(i)} y={H - 10} textAnchor="middle" fontSize="9" fill={T.textLight} fontFamily="var(--mono)">{wdShort(r.date)}</text>
            ) : null)}
          </svg>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 6, fontSize: 11, fontFamily: "var(--mono)", color: T.textMid, alignItems: "center" }}>
            <span>{ymLabel(monthA)}: <b style={{ color: T.teal }}>{fmt(aTotal)}</b> <span style={{ color: T.textLight }}>({aRows.filter(r => r.total > 0).length} days)</span></span>
            {delta != null && <span>vs {ymLabel(monthB)} (same working days): <b style={{ color: delta >= 0 ? T.teal : T.coral }}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}%</b></span>}
          </div>

          {/* clicked working-day: both months side by side */}
          {dayPanel && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: T.text, fontWeight: 700, marginBottom: 8 }}>Working day {dayPanel.i + 1}{dayPanel.loading && <span style={{ color: T.textFaint, fontWeight: 400 }}> · loading flavors…</span>}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                {[["A", monthA, T.teal, dayPanel.aDate, dayPanel.aTotal, dayPanel.aProds], ["B", monthB, T.textMid, dayPanel.bDate, dayPanel.bTotal, dayPanel.bProds]].map(([side, ym, col, dt, tot, prods]) => (
                  <div key={side} style={{ background: T.barBg, borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: col, fontWeight: 700, fontFamily: "var(--mono)" }}>{dt ? wdFull(dt) : `${ymLabel(ym)} — no day`}</span>
                      <span style={{ fontSize: 15, color: T.text, fontWeight: 800, fontFamily: "var(--mono)" }}>{fmt(tot)}</span>
                    </div>
                    {dt && ([["1", "L1", T.teal], ["2", "L2", T.coral]].map(([k, lbl, lc]) => {
                      const items = prods?.[k] || [];
                      return (
                        <div key={k} style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: lc, fontFamily: "var(--mono)", flex: "0 0 20px" }}>{lbl}</span>
                          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flex: 1 }}>
                            {items.length ? items.map(p => (
                              <span key={p.name} style={{ display: "inline-flex", alignItems: "baseline", gap: 4, background: T.card, borderRadius: 5, padding: "2px 6px" }}>
                                <span style={{ fontSize: 10, color: T.textMid }}>{p.name}</span>
                                <span style={{ fontSize: 11, color: lc, fontWeight: 700, fontFamily: "var(--mono)" }}>{fmt(p.cases)}</span>
                              </span>
                            )) : <span style={{ fontSize: 10, color: T.textFaint, fontStyle: "italic" }}>{dayPanel.loading ? "…" : "idle"}</span>}
                          </div>
                        </div>
                      );
                    }))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* flavor day list */}
          {flavor && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: T.text, fontWeight: 700, marginBottom: 8 }}>
                {flavor} — {flavorDays.length} {flavorDays.length === 1 ? "day" : "days"} in {ymLabel(monthA)}
                {flavorDays.length > 0 && <span style={{ color: T.textMid, fontWeight: 400 }}> · avg {fmt(Math.round(flavorDays.reduce((s, r) => s + flavorCasesOn(r.date, flavor), 0) / flavorDays.length))} cases</span>}
              </div>
              {flavorDays.length === 0 ? <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic" }}>No {flavor} days in {ymLabel(monthA)}.</div> : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {flavorDays.map(r => {
                    const fc = flavorCasesOn(r.date, flavor);
                    const hit = r.cap > 0 ? (r.total / r.cap) * 100 : null;
                    return (
                      <div key={r.date} style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 12, fontFamily: "var(--mono)" }}>
                        <span style={{ color: T.text, minWidth: 120 }}>{wdFull(r.date)}</span>
                        <span style={{ color: T.teal, fontWeight: 700 }}>{fmt(fc)}</span>
                        <span style={{ color: T.textMid }}>cases</span>
                        {hit != null && <span style={{ color: perfColor(hit), marginLeft: "auto", fontWeight: 700 }}>{hit.toFixed(0)}% cap</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ fontSize: 11, color: T.textMid, marginBottom: 8 }}>Monthly totals (working days only). <b style={{ color: T.teal }}>━ produced</b> · <span style={{ color: T.textLight }}>┈ capacity</span></div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", overflow: "visible" }}>
            {yTicks(yMaxH, YH)}
            {history.length > 1 && <path d={history.map((m, i) => `${i === 0 ? "M" : "L"} ${XH(i).toFixed(1)} ${YH(m.cap).toFixed(1)}`).join(" ")} fill="none" stroke={T.textLight} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.7" />}
            {history.length > 1 && <path d={pathH} fill="none" stroke={T.teal} strokeWidth="2.5" />}
            {history.map((m, i) => (
              <g key={m.ym} style={{ cursor: "pointer" }} onClick={() => { setView("compare"); setMonthA(m.ym); const p = new Date(Number(m.ym.slice(0, 4)), Number(m.ym.slice(5)) - 2, 1); setMonthB(ymKey(p)); setDayPanel(null); }}>
                <circle cx={XH(i)} cy={YH(m.total)} r={12} fill="transparent" />
                <circle cx={XH(i)} cy={YH(m.total)} r={4} fill={perfColor(m.cap > 0 ? (m.total / m.cap) * 100 : 100)} />
                <title>{m.label}: {fmt(m.total)} cases · {m.wd} working days{m.cap > 0 ? ` · ${((m.total / m.cap) * 100).toFixed(0)}% of capacity` : ""}</title>
              </g>
            ))}
            {history.map((m, i) => (
              <text key={m.ym} x={XH(i)} y={H - 10} textAnchor="middle" fontSize="9" fill={T.textLight} fontFamily="var(--mono)">{m.label.split(" ")[0]}</text>
            ))}
          </svg>
          <div style={{ fontSize: 11, color: T.textMid, fontFamily: "var(--mono)", marginTop: 6 }}>Click a month to compare it against the month before it.</div>
        </>
      )}
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

function MonthlyProgressCard({ monthEntries, now, isManager, offDays }) {
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
  const totalWD = workingDaysInMonth(now.getFullYear(), now.getMonth(), offDays);
  const remainingWD = workingDaysRemaining(now.getFullYear(), now.getMonth(), today + 1, offDays);
  const elapsedWD = Math.max(totalWD - remainingWD, 1);
  // Only days that actually ran feed the daily average — weekend/holiday rows
  // logged as 0 would otherwise drag the pace projection down.
  const daysWithData = monthEntries.filter(e => (e.line1_produced || 0) + (e.line2_produced || 0) > 0).length;

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

function MiniBar({ produced, target, capacity, label, color, hasNote, products }) {
  // When we have the live per-flavor breakdown, use its sum as the total so the
  // bar and the flavor chips always reconcile (the stored value is a snapshot
  // from that day's sync and can drift when pallets are corrected later).
  const liveTotal = products && products.length ? products.reduce((s, p) => s + (p.cases || 0), 0) : null;
  const shown = liveTotal != null ? liveTotal : (produced || 0);
  const scale = Math.max(capacity || 0, target || 0, shown, 1);
  const producedPct = Math.min((shown / scale) * 100, 100);
  const targetPct = Math.min((target / scale) * 100, 100);
  const tgtHitPct = target > 0 ? (shown / target) * 100 : null;
  const capUtilPct = capacity > 0 ? (shown / capacity) * 100 : null;
  const fixN = (n) => (n != null ? n.toFixed(1) : "—");
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: T.text, marginBottom: 5, fontFamily: "var(--mono)", gap: 6 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
          {label}{hasNote && <span style={{ fontSize: 12, opacity: 0.5 }}>💬</span>}
        </span>
        <span style={{ fontSize: 11 }}>
          <span style={{ color: T.text, fontWeight: 700 }}>{fmt(shown)}</span>
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
      {products && products.length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
          {products.map(p => (
            <span key={p.name} style={{ display: "inline-flex", alignItems: "baseline", gap: 4, background: T.barBg, borderRadius: 5, padding: "2px 7px" }}>
              <span style={{ fontSize: 10, color: T.textMid }}>{p.name}</span>
              <span style={{ fontSize: 11, color, fontWeight: 700, fontFamily: "var(--mono)" }}>{fmt(p.cases)}</span>
            </span>
          ))}
        </div>
      )}
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
  const recent = [...entries].sort((a, b) => b.date.localeCompare(a.date));
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
            <span>{diffs.length}-day avg</span>
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
  const [prodByLine, setProdByLine] = useState({ "1": [], "2": [] });

  useEffect(() => {
    setL1Start(todayEntry?.line1_filler_start || "");
    setL2Start(todayEntry?.line2_filler_start || "");
  }, [todayEntry?.date, todayEntry?.line1_filler_start, todayEntry?.line2_filler_start]);

  // Live per-line product breakdown for today (which SKUs each line is running).
  useEffect(() => {
    let cancelled = false;
    supabase.functions
      .invoke("production-detail", { body: { date: todayDate, bucket_minutes: 60 } })
      .then(({ data: res, error }) => {
        if (cancelled || error || res?.error) return;
        const by = { "1": [], "2": [] };
        for (const p of res?.products || []) {
          if (!p.line_number || !by[p.line_number]) continue;
          by[p.line_number].push({ name: p.product_name || p.short_code || "Unknown", cases: p.cases || 0 });
        }
        for (const k of Object.keys(by)) by[k].sort((a, b) => b.cases - a.cases);
        if (!cancelled) setProdByLine(by);
      });
    return () => { cancelled = true; };
  }, [todayDate, todayEntry?.last_synced_at]);

  const canEdit = userRole && userRole !== "viewer";
  const hasTodayEntry = !!todayEntry;

  // Show whichever is higher: the stored (synced) total or the live flavor sum.
  // Production only climbs during the day, so the higher number is the fresher
  // one — this keeps the headline current between syncs, no extra calls.
  const liveL1 = prodByLine["1"].reduce((s, p) => s + (p.cases || 0), 0);
  const liveL2 = prodByLine["2"].reduce((s, p) => s + (p.cases || 0), 0);
  const shownL1 = Math.max(todayEntry?.line1_produced || 0, liveL1);
  const shownL2 = Math.max(todayEntry?.line2_produced || 0, liveL2);

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
              <span style={{ fontSize: 36, fontWeight: 800, color: T.teal, fontFamily: "var(--mono)", lineHeight: 1, letterSpacing: -1 }}>{fmt(shownL1)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: T.coral, fontFamily: "var(--mono)" }}>L2</span>
              <span style={{ fontSize: 36, fontWeight: 800, color: T.coral, fontFamily: "var(--mono)", lineHeight: 1, letterSpacing: -1 }}>{fmt(shownL2)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginLeft: "auto" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: T.textMid, fontFamily: "var(--mono)" }}>TOTAL</span>
              <span style={{ fontSize: 36, fontWeight: 800, color: T.text, fontFamily: "var(--mono)", lineHeight: 1, letterSpacing: -1 }}>{fmt(shownL1 + shownL2)}</span>
            </div>
          </div>

          {/* Per-line product breakdown (which SKUs each line ran today) */}
          {(prodByLine["1"].length > 0 || prodByLine["2"].length > 0) && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
              {[["1", "L1", T.teal], ["2", "L2", T.coral]].map(([k, label, color]) => (
                <div key={k} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: "var(--mono)", flex: "0 0 20px" }}>{label}</span>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
                    {prodByLine[k].length ? prodByLine[k].map(p => (
                      <span key={p.name} style={{ display: "inline-flex", alignItems: "baseline", gap: 5, background: T.barBg, borderRadius: 6, padding: "3px 8px" }}>
                        <span style={{ fontSize: 11, color: T.text, fontWeight: 600 }}>{p.name}</span>
                        <span style={{ fontSize: 12, color, fontWeight: 800, fontFamily: "var(--mono)" }}>{fmt(p.cases)}</span>
                      </span>
                    )) : <span style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic" }}>idle</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
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

function DataEntry({ onSave, onClose, existingData, userRole, initialDate, offDays, onSetDayOff }) {
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

        {userRole !== "viewer" && onSetDayOff && (
          <label style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 12px", borderRadius: 8, background: T.barBg, marginBottom: 14, cursor: "pointer", fontFamily: "var(--mono)" }}>
            <input type="checkbox" checked={!!(offDays && offDays.has(date))} onChange={e => onSetDayOff(date, e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: T.gold }} />
            <span style={{ fontSize: 12, color: T.text }}>
              Non-working day <span style={{ color: T.textMid }}>(public holiday / no production)</span>
              <span style={{ display: "block", fontSize: 10, color: T.textFaint, marginTop: 2 }}>
                {isWeekendStr(date) ? "Weekends are skipped automatically — no need to mark." : "Stops the pending reminder and skips this day in comparisons."}
              </span>
            </span>
          </label>
        )}

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

// Section header with day-range presets + a from→to calendar picker. Reused by
// the Daily Breakdown and Filler Start sections, each with its own range state.
function RangePicker({ title, count, rangeStart, rangeEnd, setRangeStart, setRangeEnd, yestStr, applyPreset }) {
  const inputStyle = { background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 5, color: T.text, padding: "5px 8px", fontSize: 11, fontFamily: "var(--mono)", outline: "none", cursor: "pointer" };
  const presetStart = (n) => { const s = new Date(yestStr + "T12:00:00"); s.setDate(s.getDate() - (n - 1)); return localDateStr(s); };
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
      <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)" }}>
        {title} <span style={{ color: T.textMid, fontWeight: 600 }}>· {count}d</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontFamily: "var(--mono)" }}>
        {[7, 10, 14, 30].map(n => {
          const active = rangeEnd === yestStr && rangeStart === presetStart(n);
          return <button key={n} onClick={() => applyPreset(n)} style={{ padding: "4px 9px", borderRadius: 5, border: `1px solid ${T.borderStrong}`, background: active ? T.barBg : "transparent", color: T.text, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)" }}>{n}d</button>;
        })}
        <input type="date" value={rangeStart} max={rangeEnd || yestStr} onChange={e => { const v = e.target.value; if (v && (!rangeEnd || v <= rangeEnd)) setRangeStart(v); }} style={inputStyle} />
        <span style={{ fontSize: 12, color: T.textFaint }}>→</span>
        <input type="date" value={rangeEnd} min={rangeStart} max={yestStr} onChange={e => { const v = e.target.value; if (v && v <= yestStr && (!rangeStart || v >= rangeStart)) setRangeEnd(v); }} style={inputStyle} />
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
  const [offDays, setOffDays] = useState(() => new Set());
  // Read by loadData/syncNow, which are deliberately dependency-free so the 30s
  // interval isn't torn down and restarted every time a holiday is toggled.
  const offDaysRef = useRef(offDays);
  useEffect(() => { offDaysRef.current = offDays; }, [offDays]);

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  // Full load on mount and after every write. The background poll instead asks
  // only for the days that can still move — sync-production rewrites today plus
  // the previous two — and merges them into the history already in state, so the
  // repeating query stays a fixed 3 rows however many years the table grows to.
  const loadData = useCallback(async (recentOnly = false) => {
    let entriesQ = supabase
      .from("production_entries")
      .select("*")
      .order("entry_date", { ascending: false });
    if (recentOnly) {
      // Read back to the oldest day a sync can still rewrite, so the poll never
      // sits in front of a row the sync has just corrected.
      const win = recentWorkingDates(offDaysRef.current);
      entriesQ = entriesQ.gte("entry_date", win[win.length - 1]);
    }
    const [entriesRes, targetsRes, offRes] = await Promise.all([
      entriesQ,
      supabase.from("production_targets").select("*").order("effective_from", { ascending: true }),
      supabase.from("non_working_days").select("entry_date"),
    ]);
    if (entriesRes.error) console.error("load entries failed", entriesRes.error);
    if (targetsRes.error) console.error("load targets failed", targetsRes.error);
    // Soft-fail: if the table doesn't exist yet, weekends are still auto-skipped.
    if (offRes.error) console.error("load non_working_days failed", offRes.error);
    else setOffDays((prev) => (sameDateSet(prev, offRes.data) ? prev : new Set((offRes.data || []).map(r => r.entry_date))));
    // A failed targets read used to blank every default, which made the gauges
    // read 0% off perfectly good entries. Keep the last good set and sit this
    // round out instead — the entries we'd derive from [] would be wrong.
    if (targetsRes.error) { setLoading(false); return; }
    const tgts = targetsRes.data || [];
    setTargets((prev) => (sameJson(prev, tgts) ? prev : tgts));
    if (!entriesRes.error) {
      const fetched = (entriesRes.data || []).map(rowToEntry).map((e) => {
        // Fill target/cap/filler-target from the effective default for that day,
        // but only where the row has no value (a per-day override wins).
        // Use || not ??: synced rows arrive with target/capacity = 0 (not null),
        // and a 0 target is never meaningful — treat it as "unset" so the
        // effective default fills in. Otherwise today's synced row keeps 0 and
        // the gauges read as 100% (produced / 0-clamped-to-1).
        const d = effectiveTargets(e.date, tgts);
        if (!d) return e;
        return {
          ...e,
          line1_target: e.line1_target || d.line1_target,
          line1_capacity: e.line1_capacity || d.line1_capacity,
          line2_target: e.line2_target || d.line2_target,
          line2_capacity: e.line2_capacity || d.line2_capacity,
          line1_filler_target: e.line1_filler_target ?? trimTime(d.filler_start_target),
          line2_filler_target: e.line2_filler_target ?? trimTime(d.filler_start_target),
        };
      });
      // Hand back the SAME array when nothing moved. React bails out of the
      // re-render on an unchanged reference, so a poll that finds no new
      // production costs one small query and zero repaints — which is the whole
      // point of the 30s tick: numbers change, the page never visibly reloads.
      setData((prev) => {
        const next = recentOnly ? mergeEntriesByDate(prev, fetched) : fetched;
        return sameJson(prev, next) ? prev : next;
      });
    }
    setLoading(false);
  }, []);
  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { const t = setInterval(() => loadData(true), 30000); return () => clearInterval(t); }, [loadData]);

  // Pull today's live numbers on demand. The Edge Function holds the API token
  // server-side and writes via apply_production_sync (manual values are kept).
  const syncNow = useCallback(async () => {
    setSyncing(true);
    // Today plus the last 2 WORKING days, so late corrections settle (the KPI
    // otherwise only ever refreshes today's stored total) and a Monday sync
    // still reaches Friday instead of stopping at the weekend.
    const dates = recentWorkingDates(offDaysRef.current);
    const results = await Promise.all(dates.map(d =>
      supabase.functions.invoke("sync-production", { body: { date: d } })));
    setSyncing(false);
    const bad = results.find(r => r.error || r.data?.error);
    if (bad) { alert("Sync failed: " + (bad.error?.message || bad.data?.error)); return; }
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

  // Flag/unflag a date as a non-working day (holiday/shutdown). Off days drop
  // off the pending reminder and are skipped in comparisons. Weekends are
  // handled automatically and need no marking.
  const setDayOff = async (date, value) => {
    setOffDays(prev => { const n = new Set(prev); value ? n.add(date) : n.delete(date); return n; }); // optimistic
    const { error } = value
      ? await supabase.from("non_working_days").upsert({ entry_date: date }, { onConflict: "entry_date" })
      : await supabase.from("non_working_days").delete().eq("entry_date", date);
    if (error) alert("Could not update day-off: " + error.message);
    await loadData();
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
  const [paceMode, setPaceMode] = useState("target"); // "target" | "scan"
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [fillerStart, setFillerStart] = useState("");
  const [fillerEnd, setFillerEnd] = useState("");

  const sum = (a, k) => a.reduce((s, e) => s + (e[k] || 0), 0);
  const todayDateStr = productionDateStr(now);
  const historical = data.filter(d => d.date < todayDateStr);
  const sorted = [...historical].sort((a, b) => b.date.localeCompare(a.date));
  // Comparisons walk over days the plant actually ran — an off day (weekend /
  // holiday, logged as 0) is skipped, so e.g. Monday compares against Friday,
  // not Sunday's 0.
  const ranDays = sorted.filter(e => eTotal(e) > 0);
  const latest = ranDays[0] || null, previous = ranDays[1] || null;
  useEffect(() => {
    if (selectedDate == null) setSelectedDate(todayDateStr);
  }, [selectedDate, todayDateStr]);
  useEffect(() => {
    const end = new Date(todayDateStr + "T12:00:00"); end.setDate(end.getDate() - 1);
    const start = new Date(end); start.setDate(start.getDate() - 6);
    if (!rangeEnd) { setRangeEnd(localDateStr(end)); setRangeStart(localDateStr(start)); }
    if (!fillerEnd) { setFillerEnd(localDateStr(end)); setFillerStart(localDateStr(start)); }
  }, [rangeEnd, fillerEnd, todayDateStr]);
  // resolve from full data (incl. today) so Day View can show the live day
  const selectedEntry = selectedDate ? data.find(d => d.date === selectedDate) : null;
  const selTotal = eTotal(selectedEntry), selTarget = eTarget(selectedEntry), selCap = eCap(selectedEntry);
  const selPace = selectedEntry ? paceStats(selectedEntry, selectedDate, now, paceMode) : null;
  const latestTotal = eTotal(latest), latestTarget = eTarget(latest), latestCap = eCap(latest), prevTotal = eTotal(previous);
  const last5 = ranDays.slice(0, 5), prev5 = ranDays.slice(5, 10);
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
  // Daily breakdown range — defaults to the last 7 days ending yesterday; the
  // user can pick any range or a preset. Newest day on top.
  const yestStr = (() => { const y = new Date(todayDateStr + "T12:00:00"); y.setDate(y.getDate() - 1); return localDateStr(y); })();
  const rangeReady = rangeStart && rangeEnd;
  // Daily breakdown skips weekends & marked holidays — no fake 0/0 rows.
  const rangeEntries = (rangeReady
    ? historical.filter(d => d.date >= rangeStart && d.date <= rangeEnd)
    : sorted.slice(0, 7)
  ).filter(e => !isWeekendStr(e.date) && !offDays.has(e.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  const rangeDates = rangeEntries.map(e => e.date).sort();
  const rangeProducts = useDailyProducts(rangeDates);
  const applyRangePreset = (n) => {
    const s = new Date(yestStr + "T12:00:00"); s.setDate(s.getDate() - (n - 1));
    setRangeStart(localDateStr(s)); setRangeEnd(yestStr);
  };
  const fillerEntries = ((fillerStart && fillerEnd)
    ? historical.filter(d => d.date >= fillerStart && d.date <= fillerEnd)
    : sorted.slice(0, 5)
  ).filter(e => !isWeekendStr(e.date) && !offDays.has(e.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  const applyFillerPreset = (n) => {
    const s = new Date(yestStr + "T12:00:00"); s.setDate(s.getDate() - (n - 1));
    setFillerStart(localDateStr(s)); setFillerEnd(yestStr);
  };
  // Nag only for weekdays that aren't marked off — we don't run weekends or
  // holidays, so a 0 there is expected, not a missing log.
  const pendingEntries = historical.filter(e =>
    (e.line1_produced || 0) === 0 && (e.line2_produced || 0) === 0 &&
    !isWeekendStr(e.date) && !offDays.has(e.date));

  // Top 2 single-day outputs per line across every day on record (record +
  // runner-up). Recomputes on each data load, so a new high shows automatically.
  const topDays = (key) => [...data].filter(e => (e[key] || 0) > 0).sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, 2).map(e => ({ v: e[key], date: e.date }));
  const topL1 = topDays("line1_produced"), topL2 = topDays("line2_produced");

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
            <button onClick={() => openComments(null)} title="Log or view downtime" style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.borderStrong}`, background: "transparent", color: T.text, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)" }}>Downtime</button>
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

      {showEntry && <DataEntry onSave={saveEntry} onClose={closeEntry} existingData={data} userRole={userRole} initialDate={editDate} offDays={offDays} onSetDayOff={setDayOff} />}
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
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {pendingEntries.slice(0, 4).map(e => (
                  <span key={e.date} style={{ display: "inline-flex", alignItems: "center", gap: 0, border: `1px solid ${T.gold}`, borderRadius: 5, overflow: "hidden" }}>
                    <button onClick={() => openEntry(e.date)} style={{ padding: "4px 10px", border: "none", background: "transparent", color: T.text, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)" }}>
                      Fix {formatDate(e.date)}
                    </button>
                    <button onClick={() => setDayOff(e.date, true)} title="Mark as a non-working day (public holiday / shutdown) — stops the reminder and skips it in comparisons" style={{ padding: "4px 9px", border: "none", borderLeft: `1px solid ${T.gold}`, background: "transparent", color: T.textMid, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--mono)" }}>
                      Day off
                    </button>
                  </span>
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
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "inline-flex", border: `1px solid ${T.inputBorder}`, borderRadius: 5, overflow: "hidden", fontFamily: "var(--mono)", fontSize: 11 }} title="Where each line's pace clock starts — both efficiency % and bottle rate">
                    {[["target", "Target start"], ["scan", "First scan"]].map(([m, lbl]) => (
                      <button key={m} type="button" onClick={() => setPaceMode(m)}
                        style={{ padding: "5px 9px", border: "none", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11,
                          background: paceMode === m ? T.text : "transparent", color: paceMode === m ? T.bg : T.textMid, fontWeight: paceMode === m ? 700 : 500 }}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  <input type="date" value={selectedDate || ""} max={todayDateStr} onChange={e => { const v = e.target.value; if (v && v <= todayDateStr) setSelectedDate(v); }} style={{ background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 5, color: T.text, padding: "5px 9px", fontSize: 12, fontFamily: "var(--mono)", outline: "none", cursor: "pointer" }} />
                </div>
              </div>
              {!selectedEntry && selectedDate && (
                <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic", padding: "10px 0" }}>No production data for this date.</div>
              )}
              <div style={{ display: "flex", justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
                <DualGauge eff={selPace?.eff1} rHr={selPace?.rHr1} rMin={selPace?.rMin1} label="Line I" colorA={T.teal} />
                <DualGauge eff={selPace?.eff2} rHr={selPace?.rHr2} rMin={selPace?.rMin2} label="Line II" colorA={T.coral} />
                <DualGauge eff={selPace?.effTot} rHr={selPace?.rHrTot} rMin={selPace?.rMinTot} label="Combined" colorA={T.gold} />
              </div>
              {selectedEntry && selCap > 0 && (
                <div style={{ marginTop: 6, textAlign: "center", fontSize: 12, color: "#000", fontFamily: "var(--mono)" }}>
                  {selectedDate === todayDateStr ? "On pace vs capacity" : "Efficiency vs capacity"} ·{" "}
                  <b>{fmt(selPace?.pTot || 0)}</b> made / <b>{fmt(Math.round(selPace?.expTot || 0))}</b> expected {selectedDate === todayDateStr ? "by now" : "(20h)"}
                  <span style={{ color: T.textMid }}> · from {paceMode === "scan" ? "first scan" : "target start"}</span>
                </div>
              )}
              {selectedEntry?.notes && <div style={{ marginTop: 10, padding: "7px 12px", background: T.tealBg, borderRadius: 6, fontSize: 11, color: T.textMid, fontStyle: "italic", textAlign: "left" }}>💬 {selectedEntry.notes}</div>}
              {selectedDate && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}`, textAlign: "left" }}>
                  <CommentsList date={selectedDate} currentUserId={userId} isManager={userRole === "manager"} refreshTick={commentsRefreshTick} onAddClick={() => openComments(selectedDate)} compact />
                </div>
              )}
            </div>
          </div>

          <DateNav date={selectedDate} onChange={setSelectedDate} maxDate={todayDateStr} hasData={!!selectedEntry} />

          {selectedDate && <ProductionDetail date={selectedDate} isToday={selectedDate === todayDateStr}
            caps={{ "1": selectedEntry?.line1_capacity || 0, "2": selectedEntry?.line2_capacity || 0 }} />}

          <DowntimeCard date={selectedDate} refreshTick={commentsRefreshTick} />


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
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, fontFamily: "var(--mono)", marginBottom: 8 }}>Record Days</div>
              {[{ l: "L1", color: T.teal, top: topL1 }, { l: "L2", color: T.coral, top: topL2 }].map(({ l, color, top }) => (
                <div key={l} style={{ marginBottom: l === "L1" ? 8 : 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "var(--mono)" }}>{l}</span>
                  {top.length === 0 && <span style={{ fontSize: 12, color: T.textFaint, marginLeft: 6 }}>—</span>}
                  {top.map((d, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
                      <span style={{ fontSize: i === 0 ? 20 : 13, fontWeight: i === 0 ? 800 : 700, color: i === 0 ? T.text : T.textMid, fontFamily: "var(--mono)", lineHeight: 1, letterSpacing: -0.5 }}>{fmt(d.v)}</span>
                      <span style={{ fontSize: 11, color: T.textMid, fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>{formatDayShort(d.date)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <MonthlyProgressCard monthEntries={monthEntries} now={now} isManager={userRole === "manager"} offDays={offDays} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 14, marginTop: -10, marginBottom: 14, fontSize: 10, fontFamily: "var(--mono)", color: T.textMid }}>
            <span style={{ letterSpacing: 1, textTransform: "uppercase" }}>Tgt hit color:</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, background: T.teal, borderRadius: "50%" }} /> ≥ 90% on track</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, background: T.gold, borderRadius: "50%" }} /> 75–89% watch</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, background: T.coral, borderRadius: "50%" }} /> {"<"} 75% behind</span>
          </div>

          <ProductionTrend data={historical} now={now} offDays={offDays} />
          <NotesPanel entries={historical} expanded={notesOpen} onToggle={() => setNotesOpen(!notesOpen)} />

          <RangePicker title="Filler Start" count={fillerEntries.length} rangeStart={fillerStart} rangeEnd={fillerEnd} setRangeStart={setFillerStart} setRangeEnd={setFillerEnd} yestStr={yestStr} applyPreset={applyFillerPreset} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12, marginBottom: 18 }}>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}><FillerCard entries={fillerEntries} line={1} /></div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}><FillerCard entries={fillerEntries} line={2} /></div>
          </div>

          <RangePicker title="Daily Breakdown" count={rangeEntries.length} rangeStart={rangeStart} rangeEnd={rangeEnd} setRangeStart={setRangeStart} setRangeEnd={setRangeEnd} yestStr={yestStr} applyPreset={applyRangePreset} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 12 }}>
            {[{ label: "Line I", key: "line1", color: T.teal }, { label: "Line II", key: "line2", color: T.coral }].map(({ label, key, color }) => (
              <div key={key} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: T.text, fontWeight: 700, marginBottom: 12, fontFamily: "var(--mono)" }}>{label}</div>
                {rangeEntries.length === 0 && <div style={{ fontSize: 11, color: T.textFaint, fontStyle: "italic" }}>No data in this range</div>}
                {rangeEntries.map(e => <MiniBar key={e.date + key} produced={e[`${key}_produced`]} target={e[`${key}_target`]} capacity={e[`${key}_capacity`] || e[`${key}_target`]} label={formatDate(e.date)} color={color} hasNote={!!e.notes} products={rangeProducts[e.date]?.[key === "line1" ? "1" : "2"]} />)}
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
