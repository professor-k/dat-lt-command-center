import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { useLiveStream, useOverview } from '../hooks';

const NAV = [
  { to: '/fleet', label: 'Fleet Status' },
  { to: '/stations', label: 'Line Stations' },
  { to: '/defects', label: 'Defect Log' },
  { to: '/predictive', label: 'Predictive' },
];

const ROLE_LABEL = { ADMIN: 'Ops Control', ENGINEER: 'Line Engineer', VIEWER: 'Analyst' } as const;

export function Shell() {
  const { user, logout } = useAuth();
  const connected = useLiveStream();
  const { data } = useOverview();
  const [open, setOpen] = useState(false);
  const location = useLocation();

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

        {NAV.map((item) => (
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
          <button className="link-btn" onClick={logout}>
            Sign out
          </button>
        </div>
      </nav>

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

export function LiveBadge({ connected }: { connected: boolean }) {
  return (
    <span className={`live-badge${connected ? ' online' : ''}`}>
      <span className="pulse" />
      {connected ? 'Live Telemetry' : 'Reconnecting'}
    </span>
  );
}
