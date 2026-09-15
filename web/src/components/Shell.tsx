import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, type Role } from '../api';
import { useAuth } from '../auth';
import { Modal } from './ui';
import { useLiveStream, useOverview } from '../hooks';

/** `roles` restricts an entry to those roles; without it everyone signed in sees it. */
const NAV: { to: string; label: string; roles?: Role[] }[] = [
  { to: '/fleet', label: 'Fleet Status' },
  { to: '/stations', label: 'Line Stations' },
  { to: '/defects', label: 'Defect Log' },
  { to: '/predictive', label: 'Predictive' },
  { to: '/users', label: 'Access Control', roles: ['ADMIN'] },
];

export const ROLE_LABEL = { ADMIN: 'Ops Control', ENGINEER: 'Line Engineer', VIEWER: 'Analyst' } as const;

export function Shell() {
  const { user, logout, can } = useAuth();
  const connected = useLiveStream();
  const { data } = useOverview();
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const location = useLocation();

  const visibleNav = NAV.filter((item) => !item.roles || can(...item.roles));

  useEffect(() => setOpen(false), [location.pathname]);

  const counts: Record<string, number | undefined> = {
    '/fleet': data?.fleet.total,
    '/stations': data?.network.stations,
    '/defects': data?.openDefects,
  };

  const initials = (user?.name ?? '')
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="app-shell">
      <nav className={`sidebar${open ? ' open' : ''}`}>
        <div className="brand">
          <h2>DAT LT</h2>
          <p>Outstation Command Center</p>
        </div>

        {visibleNav.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => `menu-btn${isActive ? ' active' : ''}`}>
            <span>{item.label}</span>
            {counts[item.to] !== undefined ? <span className="menu-count">{counts[item.to]}</span> : null}
          </NavLink>
        ))}

        <div className="sidebar-footer">
          <div className="user-chip">
            <div className="avatar">{initials || 'DA'}</div>
            <div>
              <p className="name">{user?.name}</p>
              <p className="role">{user ? ROLE_LABEL[user.role] : ''}</p>
            </div>
          </div>
          <button className="link-btn" onClick={() => setChangingPassword(true)}>
            Change password
          </button>
          <button className="link-btn" onClick={logout}>
            Sign out
          </button>
        </div>
      </nav>

      {changingPassword ? <ChangePasswordModal onClose={() => setChangingPassword(false)} /> : null}

      <main className="main-content">
        <div className="mobile-bar">
          <button className="btn small ghost" onClick={() => setOpen((v) => !v)} aria-label="Toggle navigation">
            ☰
          </button>
          <h2>DAT LT</h2>
        </div>
        <Outlet context={{ connected }} />
      </main>
    </div>
  );
}

/** Available to every role — the only way anyone rotates their own credentials. */
function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () =>
      api('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }),
      }),
    onSuccess: () => setDone(true),
    onError: (e: Error) => setError(e.message),
  });

  const mismatch = form.confirm.length > 0 && form.confirm !== form.newPassword;
  const valid = form.currentPassword.length > 0 && form.newPassword.length >= 8 && !mismatch && form.confirm.length > 0;

  if (done) {
    return (
      <Modal title="Password changed" onClose={onClose}>
        <p className="muted" style={{ fontSize: 13 }}>
          Your password has been updated. It applies the next time you sign in — this session stays
          active.
        </p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Change password" onClose={onClose}>
      {error ? <p className="error-msg">{error}</p> : null}

      <div className="field">
        <label htmlFor="pw-current">Current Password</label>
        <input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          value={form.currentPassword}
          onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="pw-new">New Password</label>
        <input
          id="pw-new"
          type="password"
          autoComplete="new-password"
          value={form.newPassword}
          onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
        />
        <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
          At least 8 characters.
        </p>
      </div>

      <div className="field">
        <label htmlFor="pw-confirm">Confirm New Password</label>
        <input
          id="pw-confirm"
          type="password"
          autoComplete="new-password"
          value={form.confirm}
          onChange={(e) => setForm({ ...form, confirm: e.target.value })}
        />
        {mismatch ? <p className="error-msg">Passwords do not match</p> : null}
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid || change.isPending} onClick={() => change.mutate()}>
          {change.isPending ? 'Changing' : 'Change password'}
        </button>
      </div>
    </Modal>
  );
}

export function LiveBadge({ connected }: { connected: boolean }) {
  return (
    <span className={`live-badge${connected ? ' online' : ''}`}>
      <span className="pulse" />
      {connected ? 'Live Telemetry' : 'Reconnecting'}
    </span>
  );
}
