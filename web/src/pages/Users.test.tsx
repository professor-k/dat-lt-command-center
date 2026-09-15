import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsersPage } from './Users';
import { apiError, renderApp, stubApi } from '../test/render';
import type { ManagedUser } from '../api';

const user = (overrides: Partial<ManagedUser> = {}): ManagedUser => ({
  id: 'u-eng',
  email: 'engineer@test.aero',
  name: 'Dario Moretti',
  role: 'ENGINEER',
  active: true,
  createdAt: '2026-01-05T09:00:00.000Z',
  lastLoginAt: '2026-09-14T06:30:00.000Z',
  ...overrides,
});

/** The signed-in administrator, as `renderApp` establishes them. */
const SELF = user({ id: 'u-admin', email: 'ops@test.aero', name: 'Renata Villa', role: 'ADMIN' });

const renderUsers = (users: ManagedUser[], options: { as?: 'ADMIN' | 'ENGINEER'; extra?: Record<string, unknown> } = {}) => {
  const { as = 'ADMIN', extra = {} } = options;
  const stub = stubApi({ '/auth/users': { users }, ...extra }, as);
  return { stub, rendered: renderApp(<UsersPage />, { as, route: '/users' }) };
};

/**
 * Access Control is the page that can lock everyone out, so the guards that stop that are
 * the part worth holding still.
 */
describe('Users page', () => {
  it('lists the accounts for an administrator', async () => {
    const { rendered } = renderUsers([SELF, user()]);
    await rendered;

    expect(await screen.findByText('engineer@test.aero')).toBeInTheDocument();
    expect(screen.getByText('ops@test.aero')).toBeInTheDocument();
  });

  it('tells a non-administrator this is not for them', async () => {
    const { rendered } = renderUsers([], { as: 'ENGINEER' });
    await rendered;

    expect(screen.queryByText('engineer@test.aero')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add account/i })).not.toBeInTheDocument();
  });

  it('will not let an administrator change their own role or access', async () => {
    const { rendered } = renderUsers([SELF]);
    await rendered;

    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));

    // The server refuses this too; the form does not offer it in the first place.
    expect(screen.getByLabelText(/role/i)).toBeDisabled();
    expect(screen.getByLabelText(/access/i)).toBeDisabled();
    expect(screen.getByText(/cannot change your own role or lock yourself out/i)).toBeInTheDocument();
  });

  it('surfaces the server protecting the last administrator', async () => {
    const { rendered } = renderUsers([SELF, user({ id: 'u-other', role: 'ADMIN', email: 'other@test.aero' })], {
      extra: {
        'PATCH /auth/users': apiError(409, 'This is the last active administrator; promote someone else first'),
      },
    });
    await rendered;

    await userEvent.click((await screen.findAllByRole('button', { name: /edit/i }))[1]);
    await userEvent.selectOptions(screen.getByLabelText(/role/i), 'VIEWER');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/last active administrator/i)).toBeInTheDocument();
  });

  it('sends a deactivation as a PATCH rather than a delete', async () => {
    const { stub, rendered } = renderUsers([SELF, user()], {
      extra: { 'PATCH /auth/users': { user: user({ active: false }) } },
    });
    await rendered;

    await userEvent.click((await screen.findAllByRole('button', { name: /edit/i }))[1]);
    await userEvent.selectOptions(screen.getByLabelText(/access/i), 'inactive');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      const call = stub.calls.find((c) => c.method === 'PATCH');
      expect(call?.body).toMatchObject({ active: false });
    });
    // Accounts are never deleted — defects name who raised them.
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
