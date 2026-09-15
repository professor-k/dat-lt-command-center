import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Navigate, useOutletContext } from 'react-router-dom';
import { api, type ManagedUser, type Role } from '../api';
import { useUsers } from '../hooks';
import { useAuth } from '../auth';
import { LiveBadge, ROLE_LABEL } from '../components/Shell';
import { Modal, TableSkeleton, formatDate } from '../components/ui';

const ROLES: Role[] = ['ADMIN', 'ENGINEER', 'VIEWER'];

export function UsersPage() {
  const { connected } = useOutletContext<{ connected: boolean }>();
  const { user: me, can } = useAuth();
  const isAdmin = can('ADMIN');
  // The API refuses non-admins anyway; this keeps someone who types the URL from
  // landing on a page that can only show them a 403.
  const { data, isLoading } = useUsers(isAdmin);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [resetting, setResetting] = useState<ManagedUser | null>(null);

  if (!isAdmin) return <Navigate to="/fleet" replace />;

  const users = data?.users ?? [];
  const active = users.filter((u) => u.active).length;

  return (
    <section className="tab-section">
      <div className="topline">
        <div>
          <h1 className="header-title">
            Access <span>Control</span>
          </h1>
          <p className="header-sub">
            {isLoading
              ? 'Loading accounts'
              : `${users.length} account${users.length === 1 ? '' : 's'} · ${active} active`}
          </p>
        </div>
        <LiveBadge connected={connected} />
      </div>

      <div className="table-container">
        <div className="panel-head">
          <h3>Command Centre Accounts</h3>
          <button className="btn gold" onClick={() => setAdding(true)}>
            Add user
          </button>
        </div>

        {isLoading ? (
          <TableSkeleton rows={4} />
        ) : users.length === 0 ? (
          <p className="empty">No accounts on file.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Last Sign-In</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.name}</strong>
                      {user.id === me?.id ? <span className="sub">You</span> : null}
                    </td>
                    <td className="muted">{user.email}</td>
                    <td>
                      <span className="tag neutral">{ROLE_LABEL[user.role]}</span>
                    </td>
                    <td className="muted">{user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Never'}</td>
                    <td>
                      <span className={`tag ${user.active ? 'ok' : 'neutral'}`}>
                        {user.active ? 'Active' : 'Deactivated'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn small" onClick={() => setEditing(user)}>
                          Edit
                        </button>
                        <button className="btn small ghost" onClick={() => setResetting(user)}>
                          Reset password
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding ? <AddUserModal onClose={() => setAdding(false)} /> : null}
      {editing ? <EditUserModal user={editing} isSelf={editing.id === me?.id} onClose={() => setEditing(null)} /> : null}
      {resetting ? <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} /> : null}
    </section>
  );
}

function AddUserModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'VIEWER' as Role });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api('/auth/users', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          role: form.role,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const valid = form.name.trim().length >= 2 && /.+@.+\..+/.test(form.email) && form.password.length >= 8;

  return (
    <Modal title="Add user" onClose={onClose}>
      {error ? <p className="error-msg">{error}</p> : null}

      <div className="field">
        <label htmlFor="us-name">Name</label>
        <input id="us-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>

      <div className="field">
        <label htmlFor="us-email">Email</label>
        <input
          id="us-email"
          type="email"
          value={form.email}
          placeholder="engineer@dat-lt.aero"
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="us-role">Role</label>
        <select id="us-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="us-password">Initial Password</label>
        <input
          id="us-password"
          type="password"
          value={form.password}
          autoComplete="new-password"
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
          At least 8 characters. They can change it once signed in.
        </p>
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Adding' : 'Add user'}
        </button>
      </div>
    </Modal>
  );
}

function EditUserModal({ user, isSelf, onClose }: { user: ManagedUser; isSelf: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: user.name, role: user.role, active: user.active });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api(`/auth/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(form) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal title={`Edit ${user.name}`} onClose={onClose}>
      {error ? <p className="error-msg">{error}</p> : null}

      <div className="field">
        <label htmlFor="ed-name">Name</label>
        <input id="ed-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>

      <div className="field">
        <label htmlFor="ed-role">Role</label>
        <select
          id="ed-role"
          value={form.role}
          disabled={isSelf}
          onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="ed-active">Access</label>
        <select
          id="ed-active"
          value={form.active ? 'active' : 'inactive'}
          disabled={isSelf}
          onChange={(e) => setForm({ ...form, active: e.target.value === 'active' })}
        >
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
        </select>
      </div>

      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
        {isSelf
          ? 'You cannot change your own role or lock yourself out.'
          : 'Deactivating signs the account out of the command centre. Everything it raised or closed stays on the technical log.'}
      </p>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={save.isPending || form.name.trim().length < 2}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving' : 'Save changes'}
        </button>
      </div>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: ManagedUser; onClose: () => void }) {
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: () =>
      api(`/auth/users/${user.id}/password`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
    onSuccess: onClose,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal title={`Reset password — ${user.name}`} onClose={onClose}>
      {error ? <p className="error-msg">{error}</p> : null}

      <p className="muted" style={{ fontSize: 13, margin: '0 0 18px' }}>
        Sets a new password for {user.email}. Pass it to them directly; they can change it once
        they are signed in.
      </p>

      <div className="field">
        <label htmlFor="rs-password">New Password</label>
        <input
          id="rs-password"
          type="password"
          value={newPassword}
          autoComplete="new-password"
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={newPassword.length < 8 || reset.isPending}
          onClick={() => reset.mutate()}
        >
          {reset.isPending ? 'Resetting' : 'Reset password'}
        </button>
      </div>
    </Modal>
  );
}
