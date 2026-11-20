// KIWI - ask questions about production in plain English.
// A side panel in the KPI app. It sends the question to the `kiwi` Supabase
// function (which checks the signed-in user) and shows only the answer text;
// the browser never sees the database or the shift report files.
import { useEffect, useRef, useState } from 'react';
import { supabase } from './lib/supabase';

const T = {
  bg: '#F5F0E8', panel: '#FAF6EF', border: 'rgba(0,0,0,0.08)', borderStrong: 'rgba(0,0,0,0.12)',
  text: '#2C2416', textMid: 'rgba(44,36,22,0.6)', textLight: 'rgba(44,36,22,0.4)',
  teal: '#0E9990', tealBg: 'rgba(14,153,144,0.1)', coral: '#D94A42', kiwi: '#6F8F1F',
  overlay: 'rgba(44,36,22,0.35)', mono: "'JetBrains Mono', monospace", body: "'Outfit', sans-serif",
};

const SUGGESTIONS = [
  'How many cases did each line make yesterday?',
  'What caused the most downtime on Line 2 this week?',
  'Summarize the shift notes from yesterday',
  'Which batch tanks are filling or waiting right now?',
];

const STORAGE_KEY = 'kiwi.chat.v1';
function loadChat() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}
function saveChat(msgs) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-30))); } catch { /* private mode */ }
}

// Tiny, safe formatter: **bold**, "- " bullets, small pipe tables, line breaks. No HTML injection.
function Formatted({ text }) {
  const inline = (str, k) => str.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={`${k}-${i}`}>{p.slice(2, -2)}</strong> : <span key={`${k}-${i}`}>{p}</span>);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // a table = consecutive lines starting with "|"
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { if (!isRule(lines[i])) rows.push(cells(lines[i])); i++; }
      i--;
      const [head, ...body] = rows;
      out.push(
        <div key={`t${i}`} style={{ overflowX: 'auto', margin: '6px 0' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, fontFamily: T.body, width: '100%' }}>
            <thead><tr>{head.map((c, j) => <th key={j} style={{ textAlign: j ? 'right' : 'left', padding: '4px 8px', borderBottom: `1px solid ${T.borderStrong}`, color: T.textMid, fontWeight: 600, whiteSpace: 'nowrap' }}>{inline(c, `h${i}${j}`)}</th>)}</tr></thead>
            <tbody>{body.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j} style={{ textAlign: j ? 'right' : 'left', padding: '4px 8px', borderBottom: `1px solid ${T.border}`, whiteSpace: j ? 'nowrap' : 'normal' }}>{inline(c, `c${i}${k}${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>);
      continue;
    }
    const m = line.match(/^\s*[-•*]\s+(.*)$/);
    if (m) { out.push(<div key={i} style={{ display: 'flex', gap: 8, paddingLeft: 4 }}><span style={{ color: T.kiwi }}>•</span><span>{inline(m[1], i)}</span></div>); continue; }
    if (!line.trim()) { out.push(<div key={i} style={{ height: 8 }} />); continue; }
    out.push(<div key={i}>{inline(line.replace(/^#+\s*/, ''), i)}</div>);
  }
  return out;
}

// KIWI ends a clarifying question with a line like
//   [[choices: Today | This week | This month | Custom]]
// which is shown as buttons instead of text.
function splitChoices(text) {
  const m = text.match(/\n?\s*\[\[choices:\s*([^\]]+)\]\]\s*$/i);
  if (!m) return { body: text, choices: [] };
  const choices = m[1].split('|').map(c => c.trim()).filter(Boolean).slice(0, 6);
  return { body: text.slice(0, m.index).trim(), choices };
}

export default function Kiwi({ onClose }) {
  const [msgs, setMsgs] = useState(loadChat);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { saveChat(msgs); endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (choice) => {
    if (/^(custom|other|another)\b/i.test(choice)) {   // they'll type their own answer
      setHint(/^custom/i.test(choice) ? 'Type the dates, e.g. "Nov 1 to Nov 15" or "last 3 days"'
        : /^another/i.test(choice) ? 'Type the day, e.g. "Nov 17" or "last Monday"' : 'Type your answer…');
      inputRef.current?.focus();
      return;
    }
    ask(choice);
  };

  const ask = async (q) => {
    const question = (q ?? input).trim();
    if (!question || busy) return;
    setHint('');
    const history = msgs.filter(m => !m.error).map(m => ({ role: m.role, text: m.text }));
    setMsgs(m => [...m, { role: 'user', text: question }]);
    setInput('');
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('kiwi', { body: { question, history } });
      if (error) {
        let msg = 'KIWI is having trouble right now. Please try again in a minute.';
        try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ }
        throw new Error(msg);
      }
      setMsgs(m => [...m, { role: 'assistant', text: data.answer }]);
    } catch (e) {
      setMsgs(m => [...m, { role: 'assistant', text: e.message, error: true }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const clear = () => { setMsgs([]); saveChat([]); };

  // Thumbs up/down. Saved straight to kiwi_feedback (users can add, never read).
  const setFb = (i, patch) => setMsgs(ms => ms.map((m, k) => (k === i ? { ...m, fb: { ...m.fb, ...patch } } : m)));
  const sendFeedback = async (i, rating, comment = '') => {
    const m = msgs[i];
    // The question = the user's messages since KIWI's previous real answer, so a
    // clarified question is stored whole ("where are we vs target? → This month").
    const parts = [];
    for (let k = i - 1; k >= 0; k--) {
      const x = msgs[k];
      if (x.role === 'user') parts.unshift(x.text);
      else if (!x.error && splitChoices(x.text).choices.length === 0) break;
    }
    const question = parts.join(' → ');
    const context = msgs.slice(Math.max(0, i - 8), i + 1).map(x => ({ role: x.role, text: String(x.text).slice(0, 2000) }));
    setFb(i, { state: 'sending' });
    const { error } = await supabase.from('kiwi_feedback').insert({
      rating, question: question.slice(0, 2000), answer: String(m.text).slice(0, 8000),
      comment: comment.trim().slice(0, 1000) || null, context,
    });
    setFb(i, { state: error ? 'error' : 'sent', rating });
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: T.overlay, zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label="KIWI assistant"
        style={{ width: 'min(460px, 100vw)', height: '100%', background: T.panel, color: T.text, fontFamily: T.body, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 30px rgba(0,0,0,0.12)' }}>

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ width: 30, height: 30, borderRadius: '50%', background: T.kiwi, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>🥝</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, letterSpacing: 1, fontFamily: T.mono }}>KIWI</div>
            <div style={{ fontSize: 11, color: T.textLight }}>Ask about production, downtime, batches and shift reports</div>
          </div>
          {msgs.length > 0 && (
            <button onClick={clear} title="Start a new conversation" style={btn()}>New</button>
          )}
          <button onClick={onClose} title="Close (Esc)" style={btn()}>✕</button>
        </div>

        {/* messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {msgs.length === 0 && (
            <div style={{ color: T.textMid, fontSize: 14 }}>
              <div style={{ marginBottom: 12 }}>Hi! Ask me anything about the lines. For example:</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => ask(s)} style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: `1px solid ${T.borderStrong}`, background: '#fff', color: T.text, fontSize: 13, cursor: 'pointer', fontFamily: T.body }}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => {
            const { body, choices } = m.role === 'assistant' && !m.error ? splitChoices(m.text) : { body: m.text, choices: [] };
            const showChoices = choices.length > 0 && i === msgs.length - 1 && !busy;
            return (<div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{
              background: m.role === 'user' ? T.teal : m.error ? 'rgba(217,74,66,0.08)' : '#fff',
              color: m.role === 'user' ? '#fff' : m.error ? T.coral : T.text,
              border: m.role === 'user' ? 'none' : `1px solid ${T.border}`,
              borderRadius: 12, padding: '9px 13px', fontSize: 14, lineHeight: 1.45, wordBreak: 'break-word' }}>
              {m.role === 'user' ? body : <Formatted text={body} />}
            </div>
            {m.role === 'assistant' && !m.error && choices.length === 0 && <Feedback m={m} i={i} setFb={setFb} send={sendFeedback} />}
            {showChoices && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {choices.map(c => (
                  <button key={c} onClick={() => pick(c)}
                    style={{ padding: '7px 12px', borderRadius: 999, border: `1px solid ${T.teal}`, background: T.tealBg, color: T.teal, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: T.body }}>{c}</button>
                ))}
              </div>
            )}
            </div>);
          })}
          {busy && <div style={{ alignSelf: 'flex-start', color: T.textLight, fontSize: 13, fontFamily: T.mono }}>KIWI is checking the data…</div>}
          <div ref={endRef} />
        </div>

        {/* input */}
        <form onSubmit={e => { e.preventDefault(); ask(); }} style={{ display: 'flex', gap: 8, padding: 14, borderTop: `1px solid ${T.border}` }}>
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} rows={1} maxLength={1000}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
            placeholder={hint || "Ask KIWI a question…"} disabled={busy}
            style={{ flex: 1, resize: 'none', padding: '10px 12px', borderRadius: 10, border: `1px solid ${T.borderStrong}`, background: '#fff', fontSize: 14, fontFamily: T.body, color: T.text, outline: 'none' }} />
          <button type="submit" disabled={busy || !input.trim()}
            style={{ padding: '0 16px', borderRadius: 10, border: 'none', background: busy || !input.trim() ? 'rgba(14,153,144,0.4)' : T.teal, color: '#fff', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', fontFamily: T.mono, fontSize: 12 }}>ASK</button>
        </form>
        <div style={{ fontSize: 10, color: T.textLight, textAlign: 'center', padding: '0 14px 10px' }}>
          KIWI reads the shift reports, KPI entries and PLC records. Double-check important numbers.
        </div>
      </div>
    </div>
  );
}

function Feedback({ m, i, setFb, send }) {
  const fb = m.fb || {};
  const small = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '0 4px', opacity: 0.55 };
  if (fb.state === 'sent') return <div style={{ fontSize: 11, color: T.textLight, fontFamily: T.mono }}>{fb.rating > 0 ? 'Thanks!' : 'Thanks, noted.'}</div>;
  if (fb.state === 'error') return <div style={{ fontSize: 11, color: T.coral, fontFamily: T.mono }}>Couldn't save feedback.</div>;
  if (fb.state === 'down') {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input autoFocus maxLength={1000} value={fb.comment || ''} onChange={e => setFb(i, { comment: e.target.value })}
          onKeyDown={e => { if (e.key === 'Enter') send(i, -1, fb.comment || ''); }}
          placeholder="What was wrong? (optional)"
          style={{ flex: 1, padding: '6px 9px', borderRadius: 8, border: `1px solid ${T.borderStrong}`, fontSize: 12, fontFamily: T.body, background: '#fff', color: T.text, outline: 'none' }} />
        <button onClick={() => send(i, -1, fb.comment || '')} style={btn()}>Send</button>
      </div>
    );
  }
  const busy = fb.state === 'sending';
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      <button title="Good answer" disabled={busy} onClick={() => send(i, 1)} style={small}>👍</button>
      <button title="Wrong or unhelpful" disabled={busy} onClick={() => setFb(i, { state: 'down' })} style={small}>👎</button>
    </div>
  );
}

function btn() {
  return { padding: '6px 10px', borderRadius: 6, border: `1px solid ${T.borderStrong}`, background: 'transparent', color: T.textMid, fontSize: 12, cursor: 'pointer', fontFamily: T.mono };
}
