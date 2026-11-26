import React, { useState } from 'react';
import { ArrowRight, Lock, Mail, ShieldCheck, Sparkles, User } from 'lucide-react';
import { ApiError, apiRequest, setCsrfToken } from '../api/client';
import { CadenceMark } from './CadenceMark';

interface AuthScreenProps {
  onAuthenticated: () => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [provisionLocal, setProvisionLocal] = useState(false);
  const [localAddress, setLocalAddress] = useState('');
  const [seedStarter, setSeedStarter] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') {
        const res = await apiRequest<{ csrfToken: string }>('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        setCsrfToken(res.csrfToken);
      } else {
        const res = await apiRequest<{ csrfToken: string }>('/auth/register', {
          method: 'POST',
          body: {
            name,
            email,
            password,
            provisionLocalMailbox: provisionLocal,
            localEmailAddress: provisionLocal && localAddress.trim() ? localAddress.trim() : undefined,
            seedStarter: provisionLocal ? seedStarter : false,
          },
        });
        setCsrfToken(res.csrfToken);
      }
      onAuthenticated();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Unable to reach Cadence server. Please ensure the backend is running.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        placeItems: 'center',
        padding: '24px',
        background: 'var(--bg-chrome)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-xl)',
          padding: '32px',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <CadenceMark size={34} />
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>Cadence</h1>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>Calm, decisive correspondence</p>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 4,
            padding: 4,
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-subtle)',
            marginBottom: 20,
          }}
        >
          <button
            type="button"
            className={`btn btn-sm ${mode === 'login' ? '' : 'btn-ghost'}`}
            style={{
              height: 30,
              background: mode === 'login' ? 'var(--bg-elevated)' : 'transparent',
              boxShadow: mode === 'login' ? 'var(--shadow-sm)' : 'none',
            }}
            onClick={() => {
              setMode('login');
              setError('');
            }}
          >
            Sign In
          </button>
          <button
            type="button"
            className={`btn btn-sm ${mode === 'register' ? '' : 'btn-ghost'}`}
            style={{
              height: 30,
              background: mode === 'register' ? 'var(--bg-elevated)' : 'transparent',
              boxShadow: mode === 'register' ? 'var(--shadow-sm)' : 'none',
            }}
            onClick={() => {
              setMode('register');
              setError('');
            }}
          >
            Create Account
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {mode === 'register' && (
            <div>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 5 }}>
                Full name
              </label>
              <div style={{ position: 'relative' }}>
                <User size={15} style={{ position: 'absolute', left: 10, top: 10.5, color: 'var(--text-muted)' }} />
                <input
                  className="field"
                  style={{ paddingLeft: 33 }}
                  placeholder="Alex Rivera"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            </div>
          )}

          <div>
            <label style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 5 }}>
              Account email
            </label>
            <div style={{ position: 'relative' }}>
              <Mail size={15} style={{ position: 'absolute', left: 10, top: 10.5, color: 'var(--text-muted)' }} />
              <input
                type="email"
                className="field"
                style={{ paddingLeft: 33 }}
                placeholder="alex@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 5 }}>
              Password {mode === 'register' && <span style={{ color: 'var(--text-muted)' }}>(min 8 characters)</span>}
            </label>
            <div style={{ position: 'relative' }}>
              <Lock size={15} style={{ position: 'absolute', left: 10, top: 10.5, color: 'var(--text-muted)' }} />
              <input
                type="password"
                className="field"
                style={{ paddingLeft: 33 }}
                placeholder="••••••••"
                minLength={mode === 'register' ? 8 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          {mode === 'register' && (
            <div
              style={{
                padding: 12,
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-hairline)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={provisionLocal}
                  onChange={(e) => setProvisionLocal(e.target.checked)}
                />
                Optional: add an offline local test mailbox (no internet email)
              </label>

              {provisionLocal && (
                <>
                  <input
                    type="email"
                    className="field"
                    style={{ height: 32, fontSize: 12.5 }}
                    placeholder={`Local test address (defaults to ${email || 'your account email'})`}
                    value={localAddress}
                    onChange={(e) => setLocalAddress(e.target.value)}
                  />
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      style={{ marginTop: 2 }}
                      checked={seedStarter}
                      onChange={(e) => setSeedStarter(e.target.checked)}
                    />
                    <span>
                      Include sample test emails for offline UI testing
                    </span>
                  </label>
                </>
              )}
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                Right after creating your account, connect your real Gmail, Outlook / Microsoft 365, Yahoo, iCloud, or custom IMAP/SMTP inbox.
              </p>
            </div>
          )}

          {error && (
            <div
              role="alert"
              style={{
                padding: '9px 12px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--status-danger-bg)',
                color: 'var(--status-danger)',
                fontSize: 12.5,
              }}
            >
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary" style={{ height: 38 }} disabled={loading}>
            <span>{loading ? 'Authenticating...' : mode === 'login' ? 'Sign In to Workspace' : 'Create Workspace'}</span>
            <ArrowRight size={15} />
          </button>
        </form>

        <div
          style={{
            marginTop: 20,
            paddingTop: 16,
            borderTop: '1px solid var(--border-hairline)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 10,
            fontSize: 11.5,
            color: 'var(--text-muted)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <ShieldCheck size={14} /> AES-256-GCM credentials & sanitized HTML
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Sparkles size={14} /> Opt-in AI
          </span>
        </div>
      </div>
    </div>
  );
}
