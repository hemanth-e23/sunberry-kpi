import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from './lib/AuthContext';
import Dashboard from './Dashboard.jsx';
import Login from './Login.jsx';

function App() {
  const { session, profile, loading, signOut } = useAuth();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#F5F0E8', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(44,36,22,0.4)', fontFamily: "'JetBrains Mono', monospace" }}>
        Loading...
      </div>
    );
  }

  if (!session) return <Login />;

  return <Dashboard signOut={signOut} userId={session.user.id} userEmail={session.user.email} userRole={profile?.role} />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>
);
