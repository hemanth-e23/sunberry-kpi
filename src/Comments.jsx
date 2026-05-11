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

function displayName(profile, fallbackEmail) {
  if (profile?.full_name) return profile.full_name;
  const email = profile?.email || fallbackEmail;
  if (!email) return 'Unknown';
  return email.split('@')[0];
}

function CommentItem({ comment, currentUserId, isManager, onDelete }) {
  const isOwn = comment.author_id === currentUserId;
  const canDelete = isOwn || isManager;
  return (
    <div style={{ padding: '10px 0', borderBottom: `1px solid ${T.border}`, textAlign: 'left' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 12, color: T.text, fontFamily: "'JetBrains Mono', monospace" }}>
          {displayName(comment.author)}
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span title={new Date(comment.created_at).toLocaleString()} style={{ fontSize: 11, color: T.textMid, fontFamily: "'JetBrains Mono', monospace" }}>{timeAgo(comment.created_at)}</span>
          {canDelete && (
            <button onClick={() => { if (confirm('Delete this comment?')) onDelete(comment.id); }} title="Delete comment" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textLight, fontSize: 14, padding: '0 4px', lineHeight: 1 }}>×</button>
          )}
        </span>
      </div>
      <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
        {comment.text}
      </div>
    </div>
  );
}

async function fetchCommentsFor(date) {
  const { data, error } = await supabase
    .from('comments')
    .select('id, text, created_at, author_id, author:profiles!author_id(full_name, email)')
    .eq('entry_date', date)
    .order('created_at', { ascending: true });
  if (error) console.error('load comments failed', error);
  return data || [];
}

async function deleteComment(id) {
  const { error } = await supabase.from('comments').delete().eq('id', id);
  if (error) { alert('Could not delete: ' + error.message); return false; }
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

  const remove = async (id) => {
    if (await deleteComment(id)) await load();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
        <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: T.text, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
          Comments {!loading && <span style={{ color: T.textMid, fontWeight: 400 }}>({comments.length})</span>}
        </div>
        {onAddClick && (
          <button onClick={onAddClick} style={{ padding: '4px 10px', borderRadius: 5, border: `1px solid ${T.borderStrong}`, background: 'transparent', color: T.teal, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase' }}>+ Add</button>
        )}
      </div>
      <div style={{ maxHeight: compact ? 180 : 240, overflowY: 'auto', borderTop: `1px solid ${T.border}` }}>
        {loading ? (
          <div style={{ padding: '14px 0', fontSize: 11, color: T.textFaint, fontStyle: 'italic', textAlign: 'center' }}>Loading...</div>
        ) : comments.length === 0 ? (
          <div style={{ padding: '14px 0', fontSize: 11, color: T.textFaint, fontStyle: 'italic', textAlign: 'center' }}>No comments yet for this date.</div>
        ) : (
          comments.map((c) => (
            <CommentItem key={c.id} comment={c} currentUserId={currentUserId} isManager={isManager} onDelete={remove} />
          ))
        )}
      </div>
    </div>
  );
}

export default function CommentsModal({ initialDate, onClose, currentUserId, isManager }) {
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const [date, setDate] = useState(initialDate || yest.toISOString().split('T')[0]);
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setComments(await fetchCommentsFor(date));
    setLoading(false);
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const post = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPosting(true);
    const { error } = await supabase.from('comments').insert({
      entry_date: date,
      author_id: currentUserId,
      text: trimmed,
    });
    setPosting(false);
    if (error) { alert('Could not post: ' + error.message); return; }
    setText('');
    await load();
  };

  const remove = async (id) => {
    if (await deleteComment(id)) await load();
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
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: T.text, fontFamily: "'Outfit', sans-serif" }}>💬 Comments</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.textLight, fontSize: 28, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Date</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          <div style={{ fontSize: 10, color: T.textFaint, marginTop: 3 }}>Pick any date — comments are saved against that date</div>
        </div>

        <div style={{ flex: 1, minHeight: 80, maxHeight: 320, overflowY: 'auto', borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: '4px 2px', marginBottom: 14 }}>
          {loading ? (
            <div style={{ padding: '20px 0', fontSize: 12, color: T.textFaint, fontStyle: 'italic', textAlign: 'center' }}>Loading...</div>
          ) : comments.length === 0 ? (
            <div style={{ padding: '20px 0', fontSize: 12, color: T.textFaint, fontStyle: 'italic', textAlign: 'center' }}>No comments for this date yet. Be the first.</div>
          ) : (
            comments.map((c) => (
              <CommentItem key={c.id} comment={c} currentUserId={currentUserId} isManager={isManager} onDelete={remove} />
            ))
          )}
        </div>

        <div>
          <div style={labelStyle}>Add comment</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            placeholder="Type your comment..."
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, minHeight: 60 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 10, color: T.textFaint, fontFamily: "'JetBrains Mono', monospace" }}>⌘/Ctrl + Enter to post</span>
            <button
              onClick={post}
              disabled={posting || !text.trim()}
              style={{
                padding: '10px 20px', borderRadius: 6, border: 'none',
                background: posting || !text.trim() ? T.textLight : `linear-gradient(135deg, ${T.teal}, #0C8C87)`,
                color: '#fff', fontSize: 12, fontWeight: 700,
                cursor: posting || !text.trim() ? 'not-allowed' : 'pointer',
                fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1, textTransform: 'uppercase',
              }}
            >
              {posting ? 'Posting...' : 'Post'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
