import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

/** Which of the three things the card is doing: signing in, asking for a link, or using one. */
type Mode = 'sign-in' | 'forgot' | 'reset';

/** A reset link lands on the app with its token in the query string. */
const tokenFromUrl = () => new URLSearchParams(window.location.search).get('token');

export function LoginPage() {
  const initialToken = tokenFromUrl();
  const [mode, setMode] = useState<Mode>(initialToken ? 'reset' : 'sign-in');

  if (mode === 'forgot') return <ForgotCard onBack={() => setMode('sign-in')} />;
  if (mode === 'reset' && initialToken) {
    return <ResetCard token={initialToken} onDone={() => setMode('sign-in')} />;
  }
  return <SignInCard onForgot={() => setMode('forgot')} />;
}

function LoginShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>DAT LT</h1>
        <p className="tagline">Outstation Command Center</p>
        {children}
      </div>
    </div>
  );
}

function SignInCard({ onForgot }: { onForgot: () => void }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoginShell>
      <form onSubmit={onSubmit}>
        {error ? <p className="error-msg">{error}</p> : null}

        <div className="field">
          <label htmlFor="email">Operator Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Access Key</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <button className="btn gold" type="submit" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Authenticating' : 'Enter Command Center'}
        </button>

        <p style={{ textAlign: 'center', margin: '14px 0 0' }}>
          <button type="button" className="link-btn" onClick={onForgot}>
            Forgotten your access key?
          </button>
        </p>

        {/* Development only: these are published in the README, and a production build has
            no business printing working credentials on its sign-in screen. */}
        {import.meta.env.DEV ? (
          <p className="hint">
            Demo access — <code>ops@dat-lt.aero</code> / <code>CommandCenter2026!</code> (full control)
            <br />
            <code>engineer@dat-lt.aero</code> / <code>LineMaint2026!</code> (line engineer)
            <br />
            <code>viewer@dat-lt.aero</code> / <code>FleetView2026!</code> (read only)
          </p>
        ) : null}
      </form>
    </LoginShell>
  );
}

/**
 * Asks for a reset link. The server answers the same way whether or not the address is
 * registered, so this shows whatever it says rather than drawing its own conclusion.
 */
function ForgotCard({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { message } = await api<{ message: string }>('/auth/forgot', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      setMessage(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoginShell>
      {message ? (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            {message}
          </p>
          <button className="btn gold" style={{ width: '100%' }} onClick={onBack}>
            Back to sign-in
          </button>
        </>
      ) : (
        <form onSubmit={onSubmit}>
          {error ? <p className="error-msg">{error}</p> : null}

          <div className="field">
            <label htmlFor="forgot-email">Operator Email</label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <button className="btn gold" type="submit" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Requesting' : 'Request a reset link'}
          </button>

          <p style={{ textAlign: 'center', margin: '14px 0 0' }}>
            <button type="button" className="link-btn" onClick={onBack}>
              Back to sign-in
            </button>
          </p>
        </form>
      )}
    </LoginShell>
  );
}

function ResetCard({ token, onDone }: { token: string; onDone: () => void }) {
  const [form, setForm] = useState({ newPassword: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const mismatch = form.confirm.length > 0 && form.confirm !== form.newPassword;
  const valid = form.newPassword.length >= 8 && !mismatch && form.confirm.length > 0;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword: form.newPassword }),
      });
      // The token is spent; keeping it in the address bar only invites a confusing retry.
      window.history.replaceState({}, '', window.location.pathname);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <LoginShell>
        <p className="muted" style={{ fontSize: 13 }}>
          Your access key has been set. Sign in with it.
        </p>
        <button className="btn gold" style={{ width: '100%' }} onClick={onDone}>
          Back to sign-in
        </button>
      </LoginShell>
    );
  }

  return (
    <LoginShell>
      <form onSubmit={onSubmit}>
        {error ? <p className="error-msg">{error}</p> : null}

        <div className="field">
          <label htmlFor="reset-new">New Access Key</label>
          <input
            id="reset-new"
            type="password"
            autoComplete="new-password"
            value={form.newPassword}
            onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
            required
          />
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            At least 8 characters.
          </p>
        </div>

        <div className="field">
          <label htmlFor="reset-confirm">Confirm New Access Key</label>
          <input
            id="reset-confirm"
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            required
          />
          {mismatch ? <p className="error-msg">Access keys do not match</p> : null}
        </div>

        <button className="btn gold" type="submit" style={{ width: '100%' }} disabled={!valid || busy}>
          {busy ? 'Setting' : 'Set access key'}
        </button>

        <p style={{ textAlign: 'center', margin: '14px 0 0' }}>
          <button type="button" className="link-btn" onClick={onDone}>
            Back to sign-in
          </button>
        </p>
      </form>
    </LoginShell>
  );
}
