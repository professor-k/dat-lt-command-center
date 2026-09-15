import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';

export function LoginPage() {
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
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>DAT LT</h1>
        <p className="tagline">Outstation Command Center</p>

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

        <p className="hint">
          Demo access — <code>ops@dat-lt.aero</code> / <code>CommandCenter2026!</code> (full control)
          <br />
          <code>engineer@dat-lt.aero</code> / <code>LineMaint2026!</code> (line engineer)
          <br />
          <code>viewer@dat-lt.aero</code> / <code>FleetView2026!</code> (read only)
        </p>
      </form>
    </div>
  );
}
