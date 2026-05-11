import { useState } from 'react';
import { useAuth } from './lib/AuthContext';

const T = {
  bg: '#F5F0E8',
  card: 'rgba(255,255,255,0.6)',
  border: 'rgba(0,0,0,0.06)',
  text: '#2C2416',
  textLight: 'rgba(44,36,22,0.4)',
  teal: '#0E9990',
  coral: '#D94A42',
  inputBg: 'rgba(0,0,0,0.03)',
  inputBorder: 'rgba(0,0,0,0.1)',
};

const labelStyle = {
  fontSize: 9,
  letterSpacing: 1.5,
  textTransform: 'uppercase',
  color: T.textLight,
  marginBottom: 4,
  fontFamily: "'JetBrains Mono', monospace",
};

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  background: T.inputBg,
  border: `1px solid ${T.inputBorder}`,
  borderRadius: 6,
  color: T.text,
  fontSize: 14,
  fontFamily: "'JetBrains Mono', monospace",
  boxSizing: 'border-box',
  outline: 'none',
};

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } = await signIn(email, password);
    if (error) setErr(error.message);
    setBusy(false);
  };

  return (
    <div style={{ minHeight: '100vh', background: T.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Outfit', sans-serif", color: T.text }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&family=Outfit:wght@300;400;600;700;800&display=swap" rel="stylesheet" />
      <form onSubmit={submit} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 28, width: '92%', maxWidth: 360, boxShadow: '0 12px 32px rgba(0,0,0,0.05)' }}>
        <div style={{ fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: T.textLight, fontFamily: "'JetBrains Mono', monospace", marginBottom: 6 }}>Sunberry Farms</div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.5, marginBottom: 20 }}>Production KPI</h1>

        <div style={{ marginBottom: 12 }}>
          <div style={labelStyle}>Email</div>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus style={inputStyle} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Password</div>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required style={inputStyle} />
        </div>

        {err && <div style={{ fontSize: 11, color: T.coral, marginBottom: 10, fontFamily: "'JetBrains Mono', monospace" }}>{err}</div>}

        <button type="submit" disabled={busy} style={{ width: '100%', padding: 12, background: busy ? T.textLight : `linear-gradient(135deg, ${T.teal}, #0C8C87)`, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1, textTransform: 'uppercase' }}>
          {busy ? 'Signing in...' : 'Sign In'}
        </button>

        <div style={{ marginTop: 14, fontSize: 10, color: T.textLight, fontFamily: "'JetBrains Mono', monospace", textAlign: 'center' }}>
          Need access? Contact your plant manager.
        </div>
      </form>
    </div>
  );
}
