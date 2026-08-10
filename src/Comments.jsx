import { useState, useEffect, useCallback } from 'react';
import { supabase } from './lib/supabase';

const T = {
  bg: '#F5F0E8', card: 'rgba(255,255,255,0.6)', border: 'rgba(0,0,0,0.06)', borderStrong: 'rgba(0,0,0,0.1)',
  text: '#2C2416', textMid: 'rgba(44,36,22,0.6)', textLight: 'rgba(44,36,22,0.4)', textFaint: 'rgba(44,36,22,0.2)',
  teal: '#0E9990', coral: '#D94A42', tealBg: 'rgba(14,153,144,0.1)',
  modalBg: '#FAF6EF', modalOverlay: 'rgba(44,36,22,0.35)',
  inputBg: 'rgba(0,0,0,0.03)', inputBorder: 'rgba(0,0,0,0.1)',
};

function timeAgo(iso) {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function displayName(profile, fallbackEmail) {
  if (profile?.full_name) return profile.full_name;
  const email = profile?.email || fallbackEmail;
  if (!email) return 'Unknown';
  return email.split('@')[0];
}

export const CATEGORY_LABELS = {
  mechanical: 'Mechanical', production: 'Production',
  quality: 'Quality', staffing: 'Staffing', other: 'Other',
};
// Checked with the dataviz palette validator against the cream card surface:
// all five sit in the lightness band, clear 3:1 contrast, and the worst adjacent
// pair separates by ΔE 11.7 under deuteranopia. 'other' is deliberately the
// low-chroma de-emphasis slot.
export const CATEGORY_COLORS = {
  mechanical: '#D94A42', production: '#0E9990',
  quality: '#B08600', staffing: '#7A5BD9', other: '#8A8175',
};
// Order the breakdowns render in, so a category keeps its slot day to day.
export const CATEGORY_ORDER = ['mechanical', 'production', 'quality', 'staffing', 'other'];

// Which line the downtime hit. 'both' is its own bucket, never added into each
// line, so a plant-wide stoppage can't be double-counted. Entries logged before
// the line was captured have no value and report as "Not set".
export const LINES = [
  { value: '1', label: 'Line I', short: 'L1', color: '#0E9990' },
  { value: '2', label: 'Line II', short: 'L2', color: '#D94A42' },
  { value: 'both', label: 'Both lines', short: 'BOTH', color: '#7054AD' },
];
// Second level of the reason: for mechanical it's WHICH MACHINE, for production
// it's WHAT HELD US UP. Stored as the slug, displayed from the label, so renaming
// a label never orphans the history behind it. A category with no list here just
// gets the free-text "What kind?" box instead.
export const SUB_REASONS = {
  mechanical: [
    { value: 'depalletizer', label: 'Depalletizer' },
    { value: 'filler', label: 'Filler' },
    { value: 'capper', label: 'Capper' },
    { value: 'cooler', label: 'Cooler' },
    { value: 'labeler', label: 'Labeler' },
    { value: 'caser', label: 'Caser' },
    { value: 'arpac', label: 'ArPac' },
    { value: 'palletizer', label: 'Palletizer' },
    { value: 'other', label: 'Other machine' },
  ],
  production: [
    { value: 'people', label: 'People / short staffed' },
    { value: 'water_supply', label: 'Water supply' },
    { value: 'batch_not_ready', label: 'Batch not ready' },
    { value: 'no_bottles', label: 'No bottles to filler' },
    { value: 'cip_delay', label: 'CIP delay' },
    { value: 'changeover', label: 'Changeover' },
    { value: 'communication', label: 'Communication' },
    { value: 'other', label: 'Other' },
  ],
};
// Unknown slugs (older rows, free text) still render readably.
export function subReasonLabel(category, value) {
  if (!value) return null;
  const hit = (SUB_REASONS[category] || []).find(s => s.value === value);
  if (hit) return hit.label;
  return value.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

export const LINE_ORDER = ['1', '2', 'both', 'none'];
export const LINE_META = {
  ...Object.fromEntries(LINES.map(l => [l.value, l])),
  none: { value: 'none', label: 'Not set', short: '—', color: 'rgba(44,36,22,0.35)' },
};

function CommentItem({ comment, currentUserId, onEdit }) {
  const isOwn = comment.author_id === currentUserId;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);
  const [saving, setSaving] = useState(false);
  const cat = comment.category;
  const catLabel = cat ? CATEGORY_LABELS[cat] : null;
  const catColor = cat ? CATEGORY_COLORS[cat] : null;
  const subLabel = subReasonLabel(cat, comment.sub_reason);
  const mins = comment.downtime_minutes;
  const save = async () => {
    const t = draft.trim();
    if (!t || t === comment.text) { setEditing(false); return; }
    setSaving(true);
    const ok = await onEdit(comment.id, t);
    setSaving(false);
    if (ok) setEditing(false);
  };
  return (
    <div style={{ padding: '10px 0', borderBottom: `1px solid ${T.border}`, textAlign: 'left' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 6, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 12, color: T.text, fontFamily: "'JetBrains Mono', monospace" }}>
            {displayName(comment.author)}
          </span>
          {comment.line_number && (
            <span title={LINE_META[comment.line_number]?.label}
              style={{ fontSize: 9, letterSpacing: 0.5, color: '#fff', background: LINE_META[comment.line_number]?.color, padding: '2px 6px', borderRadius: 3, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
              {LINE_META[comment.line_number]?.short}
            </span>
          )}
          {catLabel && (
            <span style={{ fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase', color: '#fff', background: catColor, padding: '2px 6px', borderRadius: 3, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
              {catLabel}{subLabel ? `: ${subLabel}` : ''}
              {comment.other_specify && (cat === 'other' || comment.sub_reason === 'other') ? ` — ${comment.other_specify}` : ''}
            </span>
          )}
          {mins != null && mins > 0 && (
            <span style={{ fontSize: 10, color: T.text, background: 'rgba(217,74,66,0.12)', padding: '2px 6px', borderRadius: 3, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
              {mins}m down
            </span>
          )}
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span title={new Date(comment.created_at).toLocaleString()} style={{ fontSize: 11, color: T.textMid, fontFamily: "'JetBrains Mono', monospace" }}>{timeAgo(comment.created_at)}</span>
          {isOwn && !editing && (
            <button onClick={() => { setDraft(comment.text); setEditing(true); }} title="Edit your entry" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.teal, fontSize: 11, padding: '0 2px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>edit</button>
          )}
        </span>
      </div>
      {editing ? (
        <div>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus
            style={{ background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 6, color: T.text, padding: '8px 10px', fontSize: 13, fontFamily: "'JetBrains Mono', monospace", width: '100%', boxSizing: 'border-box', outline: 'none', resize: 'vertical', lineHeight: 1.5 }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
            <button onClick={() => setEditing(false)} disabled={saving} style={{ padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.borderStrong}`, background: 'transparent', color: T.textMid, fontSize: 10, fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={saving || !draft.trim()} style={{ padding: '4px 10px', borderRadius: 5, border: 'none', background: T.teal, color: '#fff', fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', cursor: saving ? 'wait' : 'pointer' }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          {comment.text}
        </div>
      )}
    </div>
  );
}

// `line_number` arrived with supabase_comments_line.sql. Until that migration is
// run the column doesn't exist and selecting it 400s, so fall back to the older
// shape rather than leaving the whole panel empty.
const NEW_COLS = /, (line_number|sub_reason)/g;
const COLS_DAY = 'id, text, created_at, author_id, category, downtime_minutes, other_specify, line_number, sub_reason, author:profiles!author_id(full_name, email)';
const COLS_DAY_LEGACY = COLS_DAY.replace(NEW_COLS, '');
// The range query also feeds the downtime day drill-down, so it carries the text
// and author — one fetch instead of a second round trip per day opened.
const COLS_RANGE = 'id, entry_date, created_at, text, category, downtime_minutes, other_specify, line_number, sub_reason, author:profiles!author_id(full_name, email)';
const COLS_RANGE_LEGACY = COLS_RANGE.replace(NEW_COLS, '');

async function fetchCommentsFor(date) {
  const q = (cols) => supabase.from('comments').select(cols)
    .eq('entry_date', date).order('created_at', { ascending: true });
  let { data, error } = await q(COLS_DAY);
  if (error) ({ data, error } = await q(COLS_DAY_LEGACY));
  if (error) console.error('load comments failed', error);
  return data || [];
}

export async function fetchCommentsBetween(startDate, endDate) {
  const q = (cols) => supabase.from('comments').select(cols)
    .gte('entry_date', startDate).lte('entry_date', endDate);
  let { data, error } = await q(COLS_RANGE);
  if (error) ({ data, error } = await q(COLS_RANGE_LEGACY));
  if (error) console.error('load comments range failed', error);
  return data || [];
}

async function updateComment(id, text) {
  const { error } = await supabase.from('comments').update({ text }).eq('id', id);
  if (error) { alert('Could not save: ' + error.message); return false; }
  return true;
}

export function CommentsList({ date, currentUserId, isManager, refreshTick = 0, onAddClick, compact = false }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!date) return;
    setLoading(true);
    setComments(await fetchCommentsFor(date));
    setLoading(false);
  }, [date]);

  useEffect(() => { load(); }, [load, refreshTick]);
  useEffect(() => {
    if (!date) return;
    const i = setInterval(load, 30000);
    return () => clearInterval(i);
  }, [load, date]);

  const edit = async (id, text) => {
    const ok = await updateComment(id, text);
    if (ok) await load();
    return ok;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
        <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: T.text, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
          Downtime {!loading && <span style={{ color: T.textMid, fontWeight: 400 }}>({comments.length})</span>}
        </div>
        {onAddClick && (
          <button onClick={onAddClick} style={{ padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.borderStrong}`, background: 'transparent', color: T.teal, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase' }}>+ Add</button>
        )}
      </div>
      <div style={{ maxHeight: compact ? 180 : 240, overflowY: 'auto', borderTop: `1px solid ${T.border}` }}>
        {loading ? (
          <div style={{ padding: '14px 0', fontSize: 11, color: T.textFaint, fontStyle: 'italic', textAlign: 'center' }}>Loading...</div>
        ) : comments.length === 0 ? (
          <div style={{ padding: '14px 0', fontSize: 11, color: T.textFaint, fontStyle: 'italic', textAlign: 'center' }}>Nothing logged for this date.</div>
        ) : (
          comments.map((c) => (
            <CommentItem key={c.id} comment={c} currentUserId={currentUserId} onEdit={edit} />
          ))
        )}
      </div>
    </div>
  );
}

const CATEGORIES = [
  { value: 'other', label: 'Other' },
  { value: 'mechanical', label: 'Mechanical' },
  { value: 'production', label: 'Production' },
  { value: 'quality', label: 'Quality' },
  { value: 'staffing', label: 'Staffing' },
];

export default function CommentsModal({ initialDate, onClose, currentUserId, isManager }) {
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const [date, setDate] = useState(initialDate || (() => { const y = yest.getFullYear(); const m = String(yest.getMonth()+1).padStart(2,'0'); const d = String(yest.getDate()).padStart(2,'0'); return `${y}-${m}-${d}`; })());
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [category, setCategory] = useState('other');
  const [minutes, setMinutes] = useState('');
  const [otherSpecify, setOtherSpecify] = useState('');
  const [lineNumber, setLineNumber] = useState('');
  const [subReason, setSubReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setComments(await fetchCommentsFor(date));
    setLoading(false);
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const mins = minutes === '' ? null : Math.min(parseInt(minutes) || 0, 1440);
  const isDowntime = mins != null && mins > 0;
  const subOptions = SUB_REASONS[category] || null;
  // Downtime has to belong to a line and, where the reason has a picklist, to a
  // specific cause — otherwise it can't be reported per line or per machine. A
  // plain note with no minutes needs neither.
  const needsLine = isDowntime && !lineNumber;
  const needsSub = isDowntime && !!subOptions && !subReason;
  // Free text is the escape hatch for "Other" at either level.
  const wantsSpecify = category === 'other' || subReason === 'other';
  const canPost = !!text.trim() && !needsLine && !needsSub;

  const pickCategory = (v) => { setCategory(v); setSubReason(''); };

  const post = async () => {
    const trimmed = text.trim();
    if (!trimmed || needsLine || needsSub) return;
    setPosting(true);
    const payload = {
      entry_date: date,
      author_id: currentUserId,
      text: trimmed,
      category,
      downtime_minutes: mins,
      other_specify: wantsSpecify && otherSpecify.trim() ? otherSpecify.trim() : null,
      line_number: lineNumber || null,
      sub_reason: subReason || null,
    };
    const { error } = await supabase.from('comments').insert(payload);
    setPosting(false);
    if (error) { alert('Could not save: ' + error.message); return; }
    setText('');
    setMinutes('');
    setOtherSpecify('');
    setCategory('other');
    setLineNumber('');
    setSubReason('');
    await load();
  };

  const edit = async (id, text) => {
    const ok = await updateComment(id, text);
    if (ok) await load();
    return ok;
  };

  const onTextareaKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      post();
    }
  };

  const inputStyle = {
    background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 6, color: T.text,
    padding: '10px 12px', fontSize: 14, fontFamily: "'JetBrains Mono', monospace", width: '100%',
    boxSizing: 'border-box', outline: 'none',
  };
  const labelStyle = {
    fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase',
    color: T.textLight, marginBottom: 4, fontFamily: "'JetBrains Mono', monospace",
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: T.modalOverlay, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>
      <div style={{ background: T.modalBg, border: `1px solid ${T.borderStrong}`, borderRadius: 16, padding: 24, width: '92%', maxWidth: 540, maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: T.text, fontFamily: "'Outfit', sans-serif" }}>Downtime log</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.textLight, fontSize: 28, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Date</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          <div style={{ fontSize: 10, color: T.textFaint, marginTop: 3 }}>Pick any date — the entry is saved against that date</div>
        </div>

        <div style={{ flex: 1, minHeight: 80, maxHeight: 320, overflowY: 'auto', borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: '4px 2px', marginBottom: 14 }}>
          {loading ? (
            <div style={{ padding: '20px 0', fontSize: 12, color: T.textFaint, fontStyle: 'italic', textAlign: 'center' }}>Loading...</div>
          ) : comments.length === 0 ? (
            <div style={{ padding: '20px 0', fontSize: 12, color: T.textFaint, fontStyle: 'italic', textAlign: 'center' }}>Nothing logged for this date yet.</div>
          ) : (
            comments.map((c) => (
              <CommentItem key={c.id} comment={c} currentUserId={currentUserId} onEdit={edit} />
            ))
          )}
        </div>

        <div>
          <div style={labelStyle}>What happened</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            placeholder="e.g. ArPac not sealing / vision system full"
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, minHeight: 60 }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
            <div>
              <div style={labelStyle}>Line</div>
              <select value={lineNumber} onChange={(e) => setLineNumber(e.target.value)}
                style={{ ...inputStyle, cursor: 'pointer', padding: '8px 10px', borderColor: needsLine ? T.coral : T.inputBorder }}>
                <option value="">Which line?</option>
                {LINES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>Reason</div>
              <select value={category} onChange={(e) => pickCategory(e.target.value)} style={{ ...inputStyle, cursor: 'pointer', padding: '8px 10px' }}>
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>Down (min)</div>
              <input type="number" min="0" max="1440" step="1" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="0" style={{ ...inputStyle, padding: '8px 10px' }} />
            </div>
          </div>
          {subOptions && (
            <div style={{ marginTop: 8 }}>
              <div style={labelStyle}>
                {category === 'mechanical' ? 'Which machine' : 'What held us up'}
              </div>
              <select value={subReason} onChange={(e) => setSubReason(e.target.value)}
                style={{ ...inputStyle, cursor: 'pointer', padding: '8px 10px', borderColor: needsSub ? T.coral : T.inputBorder }}>
                <option value="">{category === 'mechanical' ? 'Pick the machine…' : 'Pick the cause…'}</option>
                {subOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          )}
          {(needsLine || needsSub) && (
            <div style={{ fontSize: 10, color: T.coral, marginTop: 5, fontFamily: "'JetBrains Mono', monospace" }}>
              {needsLine && 'Pick the line — downtime is reported per line.'}
              {needsLine && needsSub && ' '}
              {needsSub && (category === 'mechanical'
                ? 'Pick the machine — so we can see which one costs us most.'
                : 'Pick the cause — so we can see what holds us up most.')}
            </div>
          )}
          {wantsSpecify && (
            <div style={{ marginTop: 8 }}>
              <div style={labelStyle}>What kind? <span style={{ textTransform: 'none', color: T.textFaint, letterSpacing: 0 }}>· spell out the "Other"</span></div>
              <input type="text" value={otherSpecify} onChange={(e) => setOtherSpecify(e.target.value)} placeholder="e.g. Utility outage, supply delay…" style={{ ...inputStyle, padding: '8px 10px' }} />
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 10, color: T.textFaint, fontFamily: "'JetBrains Mono', monospace" }}>⌘/Ctrl + Enter to save</span>
            <button
              onClick={post}
              disabled={posting || !canPost}
              style={{
                padding: '10px 20px', borderRadius: 6, border: 'none',
                background: posting || !canPost ? T.textLight : `linear-gradient(135deg, ${T.teal}, #0C8C87)`,
                color: '#fff', fontSize: 12, fontWeight: 700,
                cursor: posting || !canPost ? 'not-allowed' : 'pointer',
                fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1, textTransform: 'uppercase',
              }}
            >
              {posting ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
