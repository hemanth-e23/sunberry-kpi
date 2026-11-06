// Sugar & syrup room tank levels, read from the PLC on the plant floor.
//
// Data path: cip2.py (plant PC) -> tank_sync.py -> plc-ingest Edge Function ->
// tank_readings + plc_heartbeat. A reading is stored only when a tank moves
// 100 gal or more. The hourly heartbeat carries every tank's current level and
// proves the plant PC is alive, so a still tank and a dead feed never look the
// same. Each tank's History button lists its stored readings on demand.
import { useState, useEffect, useCallback } from 'react';
import { supabase } from './lib/supabase';

const T = {
  card: 'rgba(255,255,255,0.6)', border: 'rgba(0,0,0,0.06)', borderStrong: 'rgba(0,0,0,0.1)',
  text: '#2C2416', textMid: 'rgba(44,36,22,0.6)', textLight: 'rgba(44,36,22,0.4)', textFaint: 'rgba(44,36,22,0.2)',
  teal: '#0E9990', coral: '#D94A42', gold: '#C4920F',
  coralBg: 'rgba(217,74,66,0.07)', inner: 'rgba(0,0,0,0.03)',
  modalBg: '#FAF6EF', modalOverlay: 'rgba(44,36,22,0.35)',
  mono: "'JetBrains Mono', monospace",
};

// Gallons when full. Keep in step with tank_sync.py and the plc-ingest function.
const TANKS = [
  { name: 'CT1', capacity: 5500 },
  { name: 'CT2', capacity: 5500 },
  { name: 'SR tank 1', capacity: 6000 },
  { name: 'SR tank 2', capacity: 8000 },
  { name: 'SR tank 3', capacity: 6000 },
];

const REFRESH_MS = 5 * 60 * 1000;
const HEARTBEAT_STALE_MIN = 135;   // heartbeat is hourly; allow one miss plus slack
const HISTORY_ROWS = 500;

const fmtGal = (g) => (g == null ? '—' : Math.round(g).toLocaleString());

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

function HistoryModal({ tank, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    supabase.from('tank_readings').select('ts, gallons')
      .eq('tank', tank.name).order('ts', { ascending: false }).limit(HISTORY_ROWS)
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setRows(data || []);
      });
  }, [tank.name]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: T.modalOverlay, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label={`${tank.name} history`}
        style={{ background: T.modalBg, borderRadius: 12, width: 'min(380px, 100%)', maxHeight: '80vh',
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
          {rows && rows.length === 0 && <div style={{ padding: '12px 0', fontSize: 12, color: T.textLight, fontFamily: T.mono }}>no readings yet</div>}
          {rows && rows.map(r => (
            <div key={r.ts} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0',
              borderBottom: `1px solid ${T.border}`, fontSize: 12, fontFamily: T.mono }}>
              <span style={{ color: T.textMid }}>{dayTime(new Date(r.ts))}</span>
              <span style={{ color: T.text, fontWeight: 600 }}>{fmtGal(r.gallons)} gal</span>
            </div>
          ))}
          {rows && rows.length === HISTORY_ROWS && (
            <div style={{ paddingTop: 8, fontSize: 10, color: T.textLight, fontFamily: T.mono }}>showing the latest {HISTORY_ROWS}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function TankCard({ tank, current, onHistory }) {
  const pct = current == null ? null : current / tank.capacity;
  const color = pct == null ? T.textFaint : pct < 0.15 ? T.coral : pct > 0.95 ? T.gold : T.teal;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: T.text, fontWeight: 700, fontFamily: T.mono }}>
          {tank.name}
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
        </div>
      </div>
    </div>
  );
}

export default function TankLevels() {
  const [latest, setLatest] = useState({});
  const [hb, setHb] = useState(null);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);

  const load = useCallback(async () => {
    const [heartbeat, ...last] = await Promise.all([
      supabase.from('plc_heartbeat').select('last_seen, last_reading, levels')
        .eq('source', 'plant-pc').maybeSingle(),
      ...TANKS.map(t => supabase.from('tank_readings').select('tank, ts, gallons')
        .eq('tank', t.name).order('ts', { ascending: false }).limit(1)),
    ]);
    const failed = [heartbeat, ...last].find(r => r.error);
    if (failed) {
      setError(failed.error.message);
      return;
    }
    setError(null);
    setHb(heartbeat.data || null);
    const l = {};
    last.forEach(r => { if (r.data?.[0]) l[r.data[0].tank] = r.data[0]; });
    setLatest(l);
    setLoadedAt(Date.now());
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const closeHistory = useCallback(() => setHistoryFor(null), []);

  const end = loadedAt || Date.now();
  const hbSeen = hb?.last_seen ? Date.parse(hb.last_seen) : null;
  const hbReading = hb?.last_reading ? Date.parse(hb.last_reading) : null;
  const stale = !hbSeen || end - hbSeen > HEARTBEAT_STALE_MIN * 60000;

  const cards = TANKS.map(tank => {
    const row = latest[tank.name];
    // the heartbeat's level is newer than the last stored step if it came later
    const hbLevel = hb?.levels?.[tank.name];
    const useHb = hbLevel != null && hbReading && (!row || hbReading >= Date.parse(row.ts));
    return { tank, current: useHb ? hbLevel : row?.gallons ?? null };
  });

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: T.text, fontWeight: 700, fontFamily: T.mono }}>
          Sugar &amp; syrup room
          <span style={{ color: T.textMid, fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}> · live from plant</span>
        </div>
        <div style={{ fontSize: 11, fontFamily: T.mono, color: stale ? T.coral : T.textMid, background: stale ? T.coralBg : 'transparent', padding: stale ? '2px 8px' : 0, borderRadius: 4 }}>
          {error ? `couldn't load: ${error}`
            : !hb ? 'waiting for the first update'
            : stale ? `no update for ${ago(end - hbSeen).replace(' ago', '')} · last check ${hhmm(new Date(hbSeen))}`
            : `last check ${ago(end - hbSeen)} · ${hhmm(new Date(hbSeen))}`}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        {cards.map(c => <TankCard key={c.tank.name} {...c} onHistory={() => setHistoryFor(c.tank)} />)}
      </div>
      {historyFor && <HistoryModal tank={historyFor} onClose={closeHistory} />}
    </div>
  );
}
