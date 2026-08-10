// Downtime analytics, built straight off the `comments` table — every entry
// already carries a line, a reason (category) and downtime_minutes, so logging a
// reason IS the downtime record and there's nothing extra to key in.
//
// Answers three questions: how much did we lose on this day and to what, is the
// last week better or worse than the week before, and is the month trending up
// or down. Hover a day for its split, click it for the actual entries.
import { useState, useEffect, useCallback } from 'react';
import {
  fetchCommentsBetween, displayName, subReasonLabel,
  CATEGORY_LABELS, CATEGORY_COLORS, CATEGORY_ORDER, LINE_ORDER, LINE_META,
} from './Comments';

const T = {
  card: 'rgba(255,255,255,0.6)', border: 'rgba(0,0,0,0.06)', borderStrong: 'rgba(0,0,0,0.1)',
  text: '#2C2416', textMid: 'rgba(44,36,22,0.6)', textLight: 'rgba(44,36,22,0.4)', textFaint: 'rgba(44,36,22,0.2)',
  teal: '#0E9990', coral: '#D94A42',
  grid: 'rgba(0,0,0,0.07)', trend: 'rgba(44,36,22,0.45)',
  surface: '#FBF9F5', inner: 'rgba(0,0,0,0.03)',
  modalBg: '#FAF6EF', modalOverlay: 'rgba(44,36,22,0.35)',
  mono: "'JetBrains Mono', monospace",
};

const WINDOW_DAYS = 30;
const TREND_DAYS = 7;

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Noon-anchored so DST can never shift the result onto the wrong day.
function addDays(ds, n) {
  const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n); return localDateStr(d);
}
function monthStart(ds) { return `${ds.slice(0, 8)}01`; }
function prevMonthStart(ds) {
  const d = new Date(`${ds.slice(0, 8)}01T12:00:00`); d.setMonth(d.getMonth() - 1); return localDateStr(d);
}
function monthName(ds) { return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'long' }); }
function dayTick(ds) { return String(Number(ds.slice(8, 10))); }
function longDay(ds) {
  return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtMin(m) {
  if (!m) return '0m';
  const h = Math.floor(m / 60), mm = m % 60;
  return h > 0 ? (mm ? `${h}h ${mm}m` : `${h}h`) : `${mm}m`;
}
// Axis ticks stay narrow — "13h", not "12h 50m", which would overrun the gutter.
function fmtAxis(m) {
  if (!m) return '0';
  return m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`;
}
function clockTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Down is good here — less downtime is an improvement, so the arrow colours are
// the reverse of the production deltas elsewhere in the dashboard.
function Delta({ cur, prev, unit }) {
  if (prev == null || prev === 0) {
    return <span style={{ fontSize: 10, color: T.textFaint, fontFamily: T.mono }}>no prior data</span>;
  }
  const pct = ((cur - prev) / prev) * 100;
  const flat = Math.abs(pct) < 1;
  const color = flat ? T.textMid : pct < 0 ? T.teal : T.coral;
  return (
    <span style={{ fontSize: 10, color, fontFamily: T.mono, fontWeight: 700 }}
      title={`${fmtMin(cur)} now vs ${fmtMin(prev)} before`}>
      {flat ? '—' : pct < 0 ? '▼' : '▲'} {Math.abs(pct).toFixed(0)}% {unit}
    </span>
  );
}

function Stat({ label, minutes, children, note }) {
  return (
    <div style={{ background: T.inner, border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: T.textMid, fontFamily: T.mono, fontWeight: 700, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 22, fontWeight: 800, fontFamily: T.mono, color: minutes > 0 ? T.text : T.textLight }}>
          {fmtMin(minutes)}
        </span>
        {children}
      </div>
      {note}
    </div>
  );
}

// Swatch + label + value, used in the tiles and the tooltip.
function Row({ color, label, value, mono = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontFamily: T.mono, marginTop: 3 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: '0 0 auto' }} />
      <span style={{ color: T.textMid }}>{label}</span>
      <b style={{ marginLeft: 'auto', color: mono ? T.text : T.text }}>{value}</b>
    </div>
  );
}

// Every entry logged on one day — reason, line, how long, and what was written.
function DayDetail({ date, entries, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const withMins = entries.filter(e => (e.downtime_minutes || 0) > 0);
  const total = withMins.reduce((s, e) => s + e.downtime_minutes, 0);
  const sorted = [...entries].sort((a, b) => (b.downtime_minutes || 0) - (a.downtime_minutes || 0));
  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: T.modalOverlay, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: T.modalBg, border: `1px solid ${T.borderStrong}`, borderRadius: 16, padding: 22, width: '92%', maxWidth: 560, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text, fontFamily: "'Outfit', sans-serif" }}>{longDay(date)}</div>
            <div style={{ fontSize: 11, color: T.textMid, fontFamily: T.mono, marginTop: 2 }}>
              {fmtMin(total)} down · {withMins.length} {withMins.length === 1 ? 'entry' : 'entries'}
              {entries.length > withMins.length ? ` · ${entries.length - withMins.length} note${entries.length - withMins.length === 1 ? '' : 's'}` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.textLight, fontSize: 26, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflowY: 'auto', borderTop: `1px solid ${T.border}` }}>
          {sorted.length === 0 && (
            <div style={{ padding: '18px 0', fontSize: 12, color: T.textFaint, fontStyle: 'italic', textAlign: 'center' }}>Nothing logged for this day.</div>
          )}
          {sorted.map(e => {
            const cat = e.category || 'other';
            const line = e.line_number || 'none';
            return (
              <div key={e.id} style={{ padding: '11px 0', borderBottom: `1px solid ${T.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
                  <span style={{ fontSize: 9, letterSpacing: 0.5, color: '#fff', background: LINE_META[line].color, padding: '2px 6px', borderRadius: 3, fontFamily: T.mono, fontWeight: 700 }}>
                    {LINE_META[line].short === '—' ? 'NO LINE' : LINE_META[line].short}
                  </span>
                  <span style={{ fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase', color: '#fff', background: CATEGORY_COLORS[cat], padding: '2px 6px', borderRadius: 3, fontFamily: T.mono, fontWeight: 700 }}>
                    {CATEGORY_LABELS[cat]}{subReasonLabel(cat, e.sub_reason) ? `: ${subReasonLabel(cat, e.sub_reason)}` : ''}
                    {e.other_specify && (cat === 'other' || e.sub_reason === 'other') ? ` — ${e.other_specify}` : ''}
                  </span>
                  {(e.downtime_minutes || 0) > 0 && (
                    <span style={{ fontSize: 11, color: T.text, background: 'rgba(217,74,66,0.12)', padding: '2px 7px', borderRadius: 3, fontFamily: T.mono, fontWeight: 700 }}>
                      {fmtMin(e.downtime_minutes)}
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: T.textLight, fontFamily: T.mono }}>
                    {displayName(e.author)}{e.created_at ? ` · ${clockTime(e.created_at)}` : ''}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{e.text}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function DowntimeCard({ date, refreshTick = 0 }) {
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [split, setSplit] = useState('reason'); // bar stacking: 'reason' | 'line'
  const [hover, setHover] = useState(null);     // hovered/focused day string
  const [openDay, setOpenDay] = useState(null); // day whose entries are shown

  // One query covers the 30-day chart, the 7-vs-7 comparison and month-over-month.
  const from = date ? prevMonthStart(date) : null;
  const load = useCallback(async () => {
    if (!date) return;
    setLoading(true);
    setRows(await fetchCommentsBetween(from, date));
    setLoading(false);
  }, [date, from]);
  useEffect(() => { load(); }, [load, refreshTick]);

  if (!date) return null;

  // An entry with no minutes is a note, not downtime — it never lands in a total,
  // but it still shows in the day drill-down.
  const all = rows || [];
  const events = all.filter(r => (r.downtime_minutes || 0) > 0);
  const lineOf = (e) => e.line_number || 'none';

  const byDay = new Map();
  for (const e of events) {
    const d = byDay.get(e.entry_date) || { total: 0, cats: new Map(), lines: new Map(), count: 0 };
    const cat = e.category || 'other';
    d.total += e.downtime_minutes;
    d.count += 1;
    d.cats.set(cat, (d.cats.get(cat) || 0) + e.downtime_minutes);
    d.lines.set(lineOf(e), (d.lines.get(lineOf(e)) || 0) + e.downtime_minutes);
    byDay.set(e.entry_date, d);
  }
  const dayTotal = (d) => byDay.get(d)?.total || 0;
  const sumRange = (a, b) => {
    let t = 0;
    for (const [d, v] of byDay) if (d >= a && d <= b) t += v.total;
    return t;
  };
  const keyRange = (a, b, keyFn) => {
    const m = new Map();
    for (const e of events) if (e.entry_date >= a && e.entry_date <= b) {
      const k = keyFn(e);
      m.set(k, (m.get(k) || 0) + e.downtime_minutes);
    }
    return m;
  };
  const rowsFor = (a, b, order, keyFn) => {
    const m = keyRange(a, b, keyFn);
    return order.filter(k => m.get(k) > 0).map(k => [k, m.get(k)]);
  };

  const day = byDay.get(date) || { total: 0, cats: new Map(), lines: new Map(), count: 0 };
  const last7 = sumRange(addDays(date, -6), date);
  const prev7 = sumRange(addDays(date, -13), addDays(date, -7));
  const dayOfMonth = Number(date.slice(8, 10));
  const mtd = sumRange(monthStart(date), date);
  const lmStart = prevMonthStart(date);
  // Same number of days last month, so month-to-date isn't measured against a
  // full month.
  const lastMonthSame = sumRange(lmStart, addDays(lmStart, dayOfMonth - 1));

  const dayLines = rowsFor(date, date, LINE_ORDER, lineOf);
  const dayCats = rowsFor(date, date, CATEGORY_ORDER, e => e.category || 'other');
  const weekLines = rowsFor(addDays(date, -6), date, LINE_ORDER, lineOf);
  const weekCats = rowsFor(addDays(date, -6), date, CATEGORY_ORDER, e => e.category || 'other');
  const topReason = weekCats.length ? weekCats.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;

  // Top causes over the whole window — the second-level reason is where the
  // actionable detail lives ("labeler", not "mechanical"). Ranked bars rather
  // than more colours: past ~7 classes hues stop being tellable apart.
  const causes = (() => {
    const winStart = addDays(date, -(WINDOW_DAYS - 1));
    const m = new Map();
    for (const e of events) {
      if (e.entry_date < winStart || e.entry_date > date) continue;
      const cat = e.category || 'other';
      const sub = e.sub_reason || null;
      const key = `${cat}/${sub || '_none'}`;
      const cur = m.get(key) || {
        cat, sub, mins: 0, count: 0,
        label: subReasonLabel(cat, sub) || (sub === null ? CATEGORY_LABELS[cat] : sub),
        unspecified: !sub,
      };
      cur.mins += e.downtime_minutes;
      cur.count += 1;
      m.set(key, cur);
    }
    const list = [...m.values()].sort((a, b) => b.mins - a.mins);
    const top = list.slice(0, 6);
    const rest = list.slice(6);
    if (rest.length) {
      top.push({
        cat: 'other', sub: null, label: `${rest.length} smaller causes`, unspecified: false,
        mins: rest.reduce((s, r) => s + r.mins, 0), count: rest.reduce((s, r) => s + r.count, 0), folded: true,
      });
    }
    return { list: top, total: list.reduce((s, r) => s + r.mins, 0) };
  })();

  const byLine = split === 'line';
  const stackKeys = byLine ? LINE_ORDER : CATEGORY_ORDER;
  const colorOf = (k) => byLine ? LINE_META[k].color : CATEGORY_COLORS[k];
  const labelOf = (k) => byLine ? LINE_META[k].label : CATEGORY_LABELS[k];

  // --- chart series ---------------------------------------------------------
  const series = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = addDays(date, -i);
    const v = byDay.get(d);
    // Trailing 7-day mean — the trend line. Reads through a one-off spike.
    let sum = 0;
    for (let k = 0; k < TREND_DAYS; k++) sum += dayTotal(addDays(d, -k));
    series.push({
      d, total: v?.total || 0, cats: v?.cats || new Map(), lines: v?.lines || new Map(),
      count: v?.count || 0, avg: sum / TREND_DAYS,
    });
  }
  // The top gridline label already reads the worst day, so no bar needs a direct
  // number on it — the axis carries the max, hover carries the rest.
  const yMax = Math.max(60, ...series.map(s => Math.max(s.total, s.avg)));
  const H = 96;                       // plot height in px
  const y = (v) => (v / yMax) * H;    // minutes → px
  const hoveredDay = hover && series.find(s => s.d === hover);
  const nothingAnywhere = events.length === 0;
  const openEntries = openDay ? all.filter(e => e.entry_date === openDay) : [];

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: T.text, fontWeight: 700, fontFamily: T.mono }}>
          Downtime
          <span style={{ color: T.textMid, fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>
            {' · '}{fmtMin(day.total)} this day{day.count > 0 ? ` · ${day.count} ${day.count === 1 ? 'entry' : 'entries'}` : ''}
          </span>
        </div>
        <div style={{ display: 'inline-flex', border: `1px solid ${T.borderStrong}`, borderRadius: 5, overflow: 'hidden', fontFamily: T.mono, fontSize: 11 }}
          title="Colour the daily bars by reason or by line">
          {[['reason', 'By reason'], ['line', 'By line']].map(([m, lbl]) => (
            <button key={m} type="button" onClick={() => setSplit(m)}
              style={{ padding: '5px 10px', border: 'none', cursor: 'pointer', fontFamily: T.mono, fontSize: 11,
                background: split === m ? T.text : 'transparent', color: split === m ? '#F5F0E8' : T.textMid, fontWeight: split === m ? 700 : 500 }}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {loading && rows === null && (
        <div style={{ fontSize: 11, color: T.textFaint, fontStyle: 'italic', padding: '8px 0' }}>Loading downtime…</div>
      )}

      {rows !== null && nothingAnywhere && (
        <div style={{ fontSize: 11, color: T.textFaint, fontStyle: 'italic', padding: '8px 0' }}>
          No downtime logged since {monthName(from)} 1. Log one with a line, a reason and minutes and it shows up here.
        </div>
      )}

      {rows !== null && !nothingAnywhere && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))', gap: 10, marginBottom: 16 }}>
            <Stat label="This day · by line" minutes={day.total}
              note={dayLines.length > 0
                ? <div>{dayLines.map(([k, v]) => <Row key={k} color={LINE_META[k].color} label={LINE_META[k].label} value={fmtMin(v)} />)}</div>
                : <div style={{ fontSize: 10, color: T.textFaint, fontStyle: 'italic' }}>Nothing logged for this day.</div>} />

            <Stat label="This day · by reason" minutes={day.total}
              note={dayCats.length > 0
                ? <div>{dayCats.map(([k, v]) => <Row key={k} color={CATEGORY_COLORS[k]} label={CATEGORY_LABELS[k]} value={fmtMin(v)} />)}</div>
                : <div style={{ fontSize: 10, color: T.textFaint, fontStyle: 'italic' }}>Nothing logged for this day.</div>} />

            <Stat label="Last 7 days" minutes={last7}
              note={weekLines.length > 0
                ? <div>{weekLines.map(([k, v]) => <Row key={k} color={LINE_META[k].color} label={LINE_META[k].label} value={fmtMin(v)} />)}</div>
                : null}>
              <Delta cur={last7} prev={prev7} unit="vs prior 7" />
            </Stat>

            <Stat label={`${monthName(date)} 1–${dayOfMonth}`} minutes={mtd}
              note={<div style={{ fontSize: 10, color: T.textLight, fontFamily: T.mono }}>
                {fmtMin(lastMonthSame)} over the same days in {monthName(lmStart)}
              </div>}>
              <Delta cur={mtd} prev={lastMonthSame} unit="vs last month" />
            </Stat>

            <Stat label="Biggest reason · 7 days" minutes={topReason ? topReason[1] : 0}
              note={topReason
                ? <Row color={CATEGORY_COLORS[topReason[0]]} label={CATEGORY_LABELS[topReason[0]]}
                    value={`${Math.round((topReason[1] / last7) * 100)}% of the week`} />
                : null} />
          </div>

          {/* 30 days. Thin stacked columns on a hairline grid, with a trailing
              7-day mean over the top so a spike doesn't read as a trend. */}
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ width: 26, flex: '0 0 auto', height: H, position: 'relative' }}>
              {[1, 0.5, 0].map(f => (
                <span key={f} style={{ position: 'absolute', right: 0, top: (1 - f) * H - 5, fontSize: 8, color: T.textLight, fontFamily: T.mono }}
                  title={`${fmtMin(Math.round(yMax * f))} in a day`}>
                  {fmtAxis(Math.round(yMax * f))}
                </span>
              ))}
            </div>
            {/* Capped width — left to fill a wide card, 30 columns become fat
                blocks; a thin mark is the whole point. */}
            <div style={{ flex: 1, minWidth: 0, maxWidth: WINDOW_DAYS * 22 }}>
              <div style={{ position: 'relative', height: H }}>
                {[1, 0.5, 0].map(f => (
                  <div key={f} style={{ position: 'absolute', left: 0, right: 0, top: (1 - f) * H, height: 1, background: T.grid }} />
                ))}
                {/* trend line, drawn under the bars' hit layer */}
                <svg viewBox={`0 0 ${WINDOW_DAYS * 10} ${H}`} preserveAspectRatio="none"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: H, overflow: 'visible' }}>
                  <polyline fill="none" stroke={T.trend} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
                    points={series.map((s, i) => `${i * 10 + 5},${H - y(s.avg)}`).join(' ')} />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 2 }}>
                  {series.map((s, i) => {
                    const isSel = s.d === date;
                    const isHot = s.d === hover;
                    const stack = stackKeys.filter(k => (byLine ? s.lines : s.cats).get(k) > 0);
                    const src = byLine ? s.lines : s.cats;
                    return (
                      <button key={s.d} type="button"
                        onMouseEnter={() => setHover(s.d)} onMouseLeave={() => setHover(h => (h === s.d ? null : h))}
                        onFocus={() => setHover(s.d)} onBlur={() => setHover(h => (h === s.d ? null : h))}
                        onClick={() => setOpenDay(s.d)}
                        aria-label={`${longDay(s.d)}: ${fmtMin(s.total)} downtime. Open details.`}
                        style={{ flex: '1 1 0', minWidth: 0, height: '100%', padding: 0, border: 'none', cursor: 'pointer',
                          background: isHot ? 'rgba(44,36,22,0.05)' : isSel ? 'rgba(14,153,144,0.07)' : 'transparent',
                          borderRadius: 4, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', position: 'relative' }}>
                        {s.total > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: Math.max(3, y(s.total)),
                            borderRadius: '4px 4px 0 0', overflow: 'hidden', opacity: isHot ? 1 : 0.92 }}>
                            {stack.map((k, j) => (
                              <div key={k} style={{ flex: `${src.get(k)} 0 0`, background: colorOf(k),
                                marginTop: j === 0 ? 0 : 2 }} />
                            ))}
                          </div>
                        ) : (
                          <div style={{ height: 2, background: T.grid }} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* x ticks: month boundaries, every 5th day, and the selected day */}
              <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
                {series.map((s, i) => {
                  const isSel = s.d === date;
                  const show = isSel || i === 0 || s.d.slice(8) === '01' || (WINDOW_DAYS - 1 - i) % 5 === 0;
                  return (
                    <span key={s.d} style={{ flex: '1 1 0', minWidth: 0, textAlign: 'center', fontSize: 8,
                      color: isSel ? T.teal : T.textLight, fontWeight: isSel ? 700 : 400, fontFamily: T.mono }}>
                      {show ? dayTick(s.d) : ''}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>

          {/* hover readout: value leads, label follows */}
          <div style={{ minHeight: 46, marginTop: 8 }}>
            {hoveredDay ? (
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap', background: T.inner, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 11px' }}>
                <div style={{ fontFamily: T.mono }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{fmtMin(hoveredDay.total)}</div>
                  <div style={{ fontSize: 10, color: T.textMid }}>{longDay(hoveredDay.d)}</div>
                </div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 10, fontFamily: T.mono }}>
                  {stackKeys.filter(k => (byLine ? hoveredDay.lines : hoveredDay.cats).get(k) > 0).map(k => (
                    <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 10, height: 2, background: colorOf(k) }} />
                      <b style={{ color: T.text }}>{fmtMin((byLine ? hoveredDay.lines : hoveredDay.cats).get(k))}</b>
                      <span style={{ color: T.textMid }}>{labelOf(k)}</span>
                    </span>
                  ))}
                  {hoveredDay.total === 0 && <span style={{ color: T.textFaint, fontStyle: 'italic' }}>no downtime logged</span>}
                </div>
                <span style={{ marginLeft: 'auto', fontSize: 9, color: T.textLight, fontFamily: T.mono, whiteSpace: 'nowrap' }}>
                  {hoveredDay.count > 0 ? `${hoveredDay.count} ${hoveredDay.count === 1 ? 'entry' : 'entries'} · click for details` : 'click to open'}
                </span>
              </div>
            ) : (
              <div style={{ fontSize: 10, color: T.textFaint, fontFamily: T.mono, padding: '7px 0' }}>
                Hover a day for its split · click for the entries behind it
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4, fontSize: 10, fontFamily: T.mono, color: T.textMid }}>
            {stackKeys.map(k => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(k) }} /> {labelOf(k)}
              </span>
            ))}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 12, height: 2, background: T.trend }} /> 7-day average
            </span>
            <span style={{ color: T.textLight, marginLeft: 'auto' }}>last {WINDOW_DAYS} days</span>
          </div>

          {/* What to fix first: ranked by minutes lost over the window. */}
          {causes.list.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: T.textMid, fontFamily: T.mono, fontWeight: 700, marginBottom: 8 }}>
                Top causes · last {WINDOW_DAYS} days
              </div>
              {causes.list.map(c => {
                const share = causes.total > 0 ? (c.mins / causes.total) * 100 : 0;
                const barMax = causes.list[0].mins || 1;
                return (
                  <div key={`${c.cat}/${c.sub}/${c.label}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}
                    title={`${c.label} — ${fmtMin(c.mins)} over ${c.count} ${c.count === 1 ? 'entry' : 'entries'} (${share.toFixed(0)}% of the window)`}>
                    <span style={{ width: 132, flex: '0 0 auto', fontSize: 10, fontFamily: T.mono, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.label}
                      {c.unspecified && <span style={{ color: T.textFaint }}> · unspecified</span>}
                    </span>
                    <span style={{ width: 62, flex: '0 0 auto', fontSize: 9, fontFamily: T.mono, color: T.textLight, whiteSpace: 'nowrap' }}>
                      {c.folded ? '' : CATEGORY_LABELS[c.cat]}
                    </span>
                    <span style={{ flex: 1, minWidth: 40, maxWidth: 420, height: 8, background: T.inner, borderRadius: 4, overflow: 'hidden' }}>
                      <span style={{ display: 'block', width: `${(c.mins / barMax) * 100}%`, height: '100%',
                        background: c.folded ? T.textFaint : CATEGORY_COLORS[c.cat], borderRadius: 4 }} />
                    </span>
                    <b style={{ width: 54, flex: '0 0 auto', textAlign: 'right', fontSize: 10, fontFamily: T.mono, color: T.text }}>{fmtMin(c.mins)}</b>
                    <span style={{ width: 32, flex: '0 0 auto', textAlign: 'right', fontSize: 9, fontFamily: T.mono, color: T.textMid }}>{share.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {openDay && <DayDetail date={openDay} entries={openEntries} onClose={() => setOpenDay(null)} />}
    </div>
  );
}
