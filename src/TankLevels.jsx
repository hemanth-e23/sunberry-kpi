// Tank levels, read from the PLCs on the plant floor.
//
// Levels: cip2.py (plant PC) -> tank_sync.py -> plc-ingest Edge Function ->
// tank_readings + plc_heartbeat. A reading is stored only when a tank moves
// 200 gal or more. The hourly heartbeat carries every tank's current level and
// proves the plant PC is alive, so a still tank and a dead feed never look the
// same.
//
// Batches (BT1-BT4): line2.py records each batch from the PLC's own stage bits
// (filling, QC hold, approved, draining, empty) -> tank_sync.py ->
// tank_batches. BT cards show the current stage, and their History lists
// batches instead of level steps.
import { useState, useEffect, useCallback } from 'react';
import { supabase } from './lib/supabase';

const T = {
  card: 'rgba(255,255,255,0.6)', border: 'rgba(0,0,0,0.06)', borderStrong: 'rgba(0,0,0,0.1)',
  text: '#2C2416', textMid: 'rgba(44,36,22,0.6)', textLight: 'rgba(44,36,22,0.4)', textFaint: 'rgba(44,36,22,0.2)',
  teal: '#0E9990', coral: '#D94A42', gold: '#C4920F', purple: '#7054AD',
  tealBg: 'rgba(14,153,144,0.1)', goldBg: 'rgba(196,146,15,0.1)', purpleBg: 'rgba(112,84,173,0.1)',
  coralBg: 'rgba(217,74,66,0.07)', inner: 'rgba(0,0,0,0.03)',
  modalBg: '#FAF6EF', modalOverlay: 'rgba(44,36,22,0.35)',
  mono: "'JetBrains Mono', monospace",
};

// Gallons when full. Keep in step with tank_sync.py and the plc-ingest function.
const GROUPS = [
  { title: 'Sugar & syrup room', tanks: [
    { name: 'CT1', capacity: 5500 },
    { name: 'CT2', capacity: 5500 },
    { name: 'SR tank 1', capacity: 6000 },
    { name: 'SR tank 2', capacity: 8000 },
    { name: 'SR tank 3', capacity: 6000 },
  ] },
  { title: 'Batch tanks', tanks: [
    { name: 'BT1', line: 'Line 1', capacity: 5500, batches: true },
    { name: 'BT2', line: 'Line 1', capacity: 5500, batches: true },
    { name: 'BT3', line: 'Line 2', capacity: 5500, batches: true },
    { name: 'BT4', line: 'Line 2', capacity: 5500, batches: true },
  ] },
];
const TANKS = GROUPS.flatMap(g => g.tanks);

const REFRESH_MS = 5 * 60 * 1000;
const HEARTBEAT_STALE_MIN = 135;   // heartbeat is hourly; allow one miss plus slack
const HISTORY_ROWS = 500;
const BATCH_ROWS = 100;

// Level sensors read slightly below zero when a tank is empty (BT1/BT2 go to
// about -200), so anything under zero is shown as 0.
const fmtGal = (g) => (g == null ? '—' : Math.round(Math.max(0, g)).toLocaleString());
const fmtIn = (i) => (i == null ? '' : `${Number(i).toFixed(1)} in`);

function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)} days ago`;
}

const hhmm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayTime = (d) =>
  `${d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' })} ${hhmm(d)}`;
const dayOnly = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });

function span(fromIso, toIso) {
  if (!fromIso) return '';
  const m = Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 60000);
  if (m < 0) return '';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// Where a batch is now, from the PLC's stage bits as line2.py recorded them.
const STALE_BATCH_MS = 24 * 3600 * 1000;   // same limit line2.py uses

function stageOf(b) {
  if (!b) return null;
  if (b.empty_at || b.drain_end) return { label: 'Empty', since: b.empty_at || b.drain_end, color: T.textMid, bg: T.inner };
  // never finished and over a day old: cut off by an outage, not a real stage
  if (Date.now() - Date.parse(b.started_at) > STALE_BATCH_MS) return { label: 'No data', since: null, color: T.textLight, bg: T.inner };
  if (b.drain_start) return { label: 'Draining', since: b.drain_start, color: T.purple, bg: T.purpleBg };
  if (b.approved_at) return { label: 'Approved', since: b.approved_at, color: T.teal, bg: T.tealBg };
  if (b.full_at) return { label: 'QC hold', since: b.full_at, color: T.gold, bg: T.goldBg };
  return { label: 'Filling', since: b.started_at, color: T.teal, bg: T.tealBg };
}

// The steps of one batch, each with its start, end and length. A step still
// in progress runs to "now". Steps under a minute are dropped: they come from
// line2.py starting while the tank was already mid-batch, not from real stages.
function batchSteps(b) {
  const steps = [
    { label: 'Filling', from: b.started_at, to: b.full_at },
    { label: 'QC hold', from: b.full_at, to: b.approved_at },
    { label: 'Waiting', from: b.approved_at, to: b.drain_start },
    { label: 'Draining', from: b.drain_start, to: b.drain_end || b.empty_at },
  ];
  const out = [];
  for (const s of steps) {
    if (!s.from) break;
    if (s.to && Date.parse(s.to) - Date.parse(s.from) < 60000) continue;
    out.push(s);
  }
  return out;
}

function TankShape({ pct, color }) {
  const W = 56, H = 96, top = 10, bodyH = H - top - 4;
  const level = Math.max(0, Math.min(1, pct ?? 0));
  const fillH = bodyH * level;
  const clip = `tank-${color.replace('#', '')}-${Math.round(level * 1000)}`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <rect x="4" y={top} width={W - 8} height={bodyH} rx="10" />
        </clipPath>
      </defs>
      <ellipse cx={W / 2} cy={top} rx={(W - 8) / 2} ry="5" fill={T.inner} stroke={T.borderStrong} />
      <rect x="4" y={top} width={W - 8} height={bodyH} rx="10" fill={T.inner} stroke={T.borderStrong} />
      {pct != null && (
        <rect x="4" y={top + bodyH - fillH} width={W - 8} height={fillH}
          fill={color} opacity="0.75" clipPath={`url(#${clip})`} />
      )}
      {[0.25, 0.5, 0.75].map(f => (
        <line key={f} x1={W - 12} x2={W - 4} y1={top + bodyH * (1 - f)} y2={top + bodyH * (1 - f)}
          stroke={T.textLight} strokeWidth="1" />
      ))}
    </svg>
  );
}

function BatchBlock({ b }) {
  const steps = batchSteps(b);
  const done = b.empty_at || b.drain_end;
  const cutOff = !done && Date.now() - Date.parse(b.started_at) > STALE_BATCH_MS;
  return (
    <div style={{ padding: '10px 0', borderBottom: `1px solid ${T.border}`, fontFamily: T.mono }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6, fontSize: 12 }}>
        <span style={{ color: T.text, fontWeight: 700 }}>
          {dayOnly(new Date(b.started_at))}
          {b.recipe && <span style={{ color: T.textMid, fontWeight: 500 }}> · {b.recipe}</span>}
        </span>
        <span style={{ color: T.textMid, whiteSpace: 'nowrap' }}>peak {b.peak == null ? '—' : fmtGal(b.peak)} gal</span>
      </div>
      {steps.map(s => (
        <div key={s.label} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' }}>
          <span style={{ color: T.textMid, width: 64 }}>{s.label}</span>
          <span style={{ color: T.text, flex: 1 }}>
            {hhmm(new Date(s.from))} → {s.to ? hhmm(new Date(s.to))
              : cutOff ? <span style={{ color: T.textLight }}>no data after this</span>
              : done ? <span style={{ color: T.textLight }}>?</span>
              : <b style={{ color: T.teal }}>now</b>}
          </span>
          <span style={{ color: T.textMid, minWidth: 54, textAlign: 'right' }}>{s.to || (!cutOff && !done) ? span(s.from, s.to) : ''}</span>
        </div>
      ))}
      {done && (
        <div style={{ display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' }}>
          <span style={{ color: T.textMid, width: 64 }}>Empty</span>
          <span style={{ color: T.text, flex: 1 }}>{hhmm(new Date(done))}</span>
          <span style={{ color: T.textMid, minWidth: 54, textAlign: 'right' }}>total {span(b.started_at, done)}</span>
        </div>
      )}
    </div>
  );
}

function HistoryModal({ tank, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const q = tank.batches
      ? supabase.from('tank_batches').select('started_at, full_at, approved_at, drain_start, drain_end, empty_at, peak, recipe')
          .eq('tank', tank.name).order('started_at', { ascending: false }).limit(BATCH_ROWS)
      : supabase.from('tank_readings').select('ts, gallons, inches')
          .eq('tank', tank.name).order('ts', { ascending: false }).limit(HISTORY_ROWS);
    q.then(({ data, error }) => {
      if (error) setError(error.message);
      else setRows(data || []);
    });
  }, [tank.name, tank.batches]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: T.modalOverlay, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label={`${tank.name} history`}
        style={{ background: T.modalBg, borderRadius: 12, width: `min(${tank.batches ? 440 : 380}px, 100%)`, maxHeight: '80vh',
          display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px',
          borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', fontWeight: 700, color: T.text, fontFamily: T.mono }}>
            {tank.name} history
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: T.textMid, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '4px 16px 12px' }}>
          {error && <div style={{ padding: '12px 0', fontSize: 12, color: T.coral, fontFamily: T.mono }}>couldn't load: {error}</div>}
          {!error && rows === null && <div style={{ padding: '12px 0', fontSize: 12, color: T.textLight, fontFamily: T.mono }}>loading…</div>}
          {rows && rows.length === 0 && <div style={{ padding: '12px 0', fontSize: 12, color: T.textLight, fontFamily: T.mono }}>
            {tank.batches ? 'no batches recorded yet' : 'no readings yet'}</div>}
          {rows && tank.batches && rows.map(b => <BatchBlock key={b.started_at} b={b} />)}
          {rows && !tank.batches && rows.map(r => (
            <div key={r.ts} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0',
              borderBottom: `1px solid ${T.border}`, fontSize: 12, fontFamily: T.mono }}>
              <span style={{ color: T.textMid, flex: 1 }}>{dayTime(new Date(r.ts))}</span>
              <span style={{ color: T.text, fontWeight: 600, minWidth: 80, textAlign: 'right' }}>{fmtGal(r.gallons)} gal</span>
              <span style={{ color: T.textMid, minWidth: 64, textAlign: 'right' }}>{fmtIn(r.inches)}</span>
            </div>
          ))}
          {rows && rows.length === (tank.batches ? BATCH_ROWS : HISTORY_ROWS) && (
            <div style={{ paddingTop: 8, fontSize: 10, color: T.textLight, fontFamily: T.mono }}>showing the latest {rows.length}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function TankCard({ tank, current, inches, stage, onHistory }) {
  const pct = current == null ? null : Math.max(0, current) / tank.capacity;
  const color = pct == null ? T.textFaint : pct < 0.15 ? T.coral : pct > 0.95 ? T.gold : T.teal;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: T.text, fontWeight: 700, fontFamily: T.mono }}>
          {tank.name}
          {tank.line && <span style={{ color: T.textLight, fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}> · {tank.line}</span>}
        </div>
        <button type="button" onClick={onHistory}
          style={{ border: `1px solid ${T.borderStrong}`, background: 'transparent', borderRadius: 5, padding: '3px 8px',
            fontSize: 10, fontFamily: T.mono, color: T.textMid, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 1 }}>
          History
        </button>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <TankShape pct={pct} color={color} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: T.text, fontFamily: T.mono, lineHeight: 1.1 }}>
            {fmtGal(current)}<span style={{ fontSize: 11, color: T.textMid, fontWeight: 500 }}> gal</span>
          </div>
          <div style={{ fontSize: 12, color, fontWeight: 700, fontFamily: T.mono, marginTop: 2 }}>
            {pct == null ? '—' : `${Math.round(pct * 100)}%`}
            <span style={{ color: T.textLight, fontWeight: 500 }}> of {tank.capacity.toLocaleString()}</span>
          </div>
          {inches != null && (
            <div style={{ fontSize: 12, color: T.textMid, fontFamily: T.mono, marginTop: 2 }}>{fmtIn(inches)}</div>
          )}
          {stage && (
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: T.mono, whiteSpace: 'nowrap' }}>
              <span style={{ color: stage.color, background: stage.bg, fontWeight: 700, padding: '2px 7px', borderRadius: 4 }}>
                {stage.label}
              </span>
              {stage.since && (
                <span style={{ color: T.textLight }}>
                  {stage.label === 'Empty'
                    ? ` since ${Date.now() - Date.parse(stage.since) > 20 * 3600 * 1000 ? dayTime(new Date(stage.since)) : hhmm(new Date(stage.since))}`
                    : ` for ${span(stage.since)}`}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TankLevels() {
  const [latest, setLatest] = useState({});
  const [lastBatch, setLastBatch] = useState({});
  const [hb, setHb] = useState(null);
  const [error, setError] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);

  const load = useCallback(async () => {
    const batchTanks = TANKS.filter(t => t.batches);
    const [heartbeat, ...rest] = await Promise.all([
      supabase.from('plc_heartbeat').select('last_seen, last_reading, levels, inches')
        .eq('source', 'plant-pc').maybeSingle(),
      ...TANKS.map(t => supabase.from('tank_readings').select('tank, ts, gallons, inches, received_at')
        .eq('tank', t.name).order('ts', { ascending: false }).limit(1)),
      ...batchTanks.map(t => supabase.from('tank_batches')
        .select('tank, started_at, full_at, approved_at, drain_start, drain_end, empty_at, updated_at')
        .eq('tank', t.name).order('started_at', { ascending: false }).limit(1)),
    ]);
    const failed = [heartbeat, ...rest].find(r => r.error);
    if (failed) {
      setError(failed.error.message);
      return;
    }
    setError(null);
    setHb(heartbeat.data || null);
    const l = {};
    rest.slice(0, TANKS.length).forEach(r => { if (r.data?.[0]) l[r.data[0].tank] = r.data[0]; });
    setLatest(l);
    const b = {};
    rest.slice(TANKS.length).forEach(r => { if (r.data?.[0]) b[r.data[0].tank] = r.data[0]; });
    setLastBatch(b);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  // keep "updated X min ago" counting between the 5-minute reloads
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const closeHistory = useCallback(() => setHistoryFor(null), []);

  const nowMs = Date.now();
  const hbSeen = hb?.last_seen ? Date.parse(hb.last_seen) : null;
  const hbReading = hb?.last_reading ? Date.parse(hb.last_reading) : null;
  // The heartbeat is only hourly, but every level change and batch change is
  // also news from the plant -- show whichever arrived most recently.
  const lastUpdate = Math.max(0, hbSeen || 0,
    ...Object.values(latest).map(r => Date.parse(r.received_at) || 0),
    ...Object.values(lastBatch).map(b => Date.parse(b.updated_at) || 0)) || null;
  const stale = !lastUpdate || nowMs - lastUpdate > HEARTBEAT_STALE_MIN * 60000;

  const cardFor = (tank) => {
    const row = latest[tank.name];
    // the heartbeat's level is newer than the last stored step if it came later
    const hbLevel = hb?.levels?.[tank.name];
    const useHb = hbLevel != null && hbReading && (!row || hbReading >= Date.parse(row.ts));
    const hbInches = hb?.inches?.[tank.name];
    return {
      tank,
      current: useHb ? hbLevel : row?.gallons ?? null,
      inches: useHb ? hbInches ?? null : row?.inches ?? null,
      stage: tank.batches ? stageOf(lastBatch[tank.name]) : null,
    };
  };

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: T.text, fontWeight: 700, fontFamily: T.mono }}>
          Tanks
          <span style={{ color: T.textMid, fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}> · live from plant</span>
        </div>
        <div style={{ fontSize: 11, fontFamily: T.mono, color: stale ? T.coral : T.textMid, background: stale ? T.coralBg : 'transparent', padding: stale ? '2px 8px' : 0, borderRadius: 4 }}>
          {error ? `couldn't load: ${error}`
            : !lastUpdate ? 'waiting for the first update'
            : stale ? `no update for ${ago(nowMs - lastUpdate).replace(' ago', '')} · last ${hhmm(new Date(lastUpdate))}`
            : `updated ${ago(nowMs - lastUpdate)} · ${hhmm(new Date(lastUpdate))}`}
        </div>
      </div>
      {GROUPS.map((g, i) => (
        <div key={g.title} style={{ marginTop: i ? 14 : 0 }}>
          <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: T.textMid, fontWeight: 700, fontFamily: T.mono, marginBottom: 8 }}>
            {g.title}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
            {g.tanks.map(tank => (
              <TankCard key={tank.name} {...cardFor(tank)} onHistory={() => setHistoryFor(tank)} />
            ))}
          </div>
        </div>
      ))}
      {historyFor && <HistoryModal tank={historyFor} onClose={closeHistory} />}
    </div>
  );
}
