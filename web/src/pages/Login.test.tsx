import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from './Login';
import { apiError, renderApp, stubApi } from '../test/render';

const signIn = async (email: string, password: string) => {
  await userEvent.type(screen.getByLabelText(/operator email/i), email);
  await userEvent.type(screen.getByLabelText(/access key/i), password);
  await userEvent.click(screen.getByRole('button', { name: /enter command center/i }));
};

describe('Login page', () => {
  describe('signing in', () => {
    it('sends the credentials to the API', async () => {
      const stub = stubApi(
        { 'POST /auth/login': { token: 't', user: { id: 'u', email: 'ops@test.aero', name: 'Renata Villa', role: 'ADMIN' } } },
        null,
      );
      await renderApp(<LoginPage />, { as: null, route: '/login' });

      await signIn('ops@test.aero', 'CommandCenter2026!');

      await waitFor(() => {
        const call = stub.calls.find((c) => c.url.includes('/auth/login'));
        expect(call?.body).toEqual({ email: 'ops@test.aero', password: 'CommandCenter2026!' });
      });
    });

    it('shows what the server said about a bad password', async () => {
      stubApi({ 'POST /auth/login': apiError(401, 'Invalid credentials') }, null);
      await renderApp(<LoginPage />, { as: null, route: '/login' });

      await signIn('ops@test.aero', 'wrong');

      expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
    });

    it('says plainly when the account has been deactivated', async () => {
      stubApi({ 'POST /auth/login': apiError(401, 'This account has been deactivated') }, null);
      await renderApp(<LoginPage />, { as: null, route: '/login' });

      await signIn('gone@test.aero', 'CommandCenter2026!');

      expect(await screen.findByText(/deactivated/i)).toBeInTheDocument();
    });
  });

  describe('asking for a reset link', () => {
    it('shows whatever the server answers, without drawing its own conclusion', async () => {
      const message = 'Password resets by email are not configured here — ask an administrator to reset your password.';
      stubApi({ 'POST /auth/forgot': { message } }, null);
      await renderApp(<LoginPage />, { as: null, route: '/login' });

      await userEvent.click(screen.getByRole('button', { name: /forgotten your access key/i }));
      await userEvent.type(screen.getByLabelText(/operator email/i), 'someone@test.aero');
      await userEvent.click(screen.getByRole('button', { name: /request a reset link/i }));

      expect(await screen.findByText(message)).toBeInTheDocument();
    });

    it('can be backed out of', async () => {
      stubApi({}, null);
      await renderApp(<LoginPage />, { as: null, route: '/login' });

      await userEvent.click(screen.getByRole('button', { name: /forgotten your access key/i }));
      expect(screen.getByRole('button', { name: /request a reset link/i })).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /back to sign-in/i }));
      expect(await screen.findByRole('button', { name: /enter command center/i })).toBeInTheDocument();
    });
  });

  describe('following a reset link', () => {
    const openResetLink = async () => {
      window.history.replaceState({}, '', '/login?token=a-reset-token-from-the-mail');
      await renderApp(<LoginPage />, { as: null, route: '/login?token=a-reset-token-from-the-mail' });
    };

    it('asks for a new access key instead of signing in', async () => {
      stubApi({}, null);
      await openResetLink();

      expect(await screen.findByLabelText('New Access Key')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /enter command center/i })).not.toBeInTheDocument();
    });

    it('sends the token from the link with the new password', async () => {
      const stub = stubApi({ 'POST /auth/reset': {} }, null);
      await openResetLink();

      await userEvent.type(await screen.findByLabelText('New Access Key'), 'BrandNewPassword9!');
      await userEvent.type(screen.getByLabelText('Confirm New Access Key'), 'BrandNewPassword9!');
      await userEvent.click(screen.getByRole('button', { name: /set access key/i }));

      await waitFor(() => {
        const call = stub.calls.find((c) => c.url.includes('/auth/reset'));
        expect(call?.body).toEqual({ token: 'a-reset-token-from-the-mail', newPassword: 'BrandNewPassword9!' });
      });
    });

    it('will not submit two access keys that do not match', async () => {
      stubApi({}, null);
      await openResetLink();

      await userEvent.type(await screen.findByLabelText('New Access Key'), 'BrandNewPassword9!');
      await userEvent.type(screen.getByLabelText('Confirm New Access Key'), 'SomethingElse9!');

      expect(screen.getByText(/do not match/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /set access key/i })).toBeDisabled();
    });

    it('says so when the link has already been used', async () => {
      stubApi({ 'POST /auth/reset': apiError(400, 'That reset link is no longer valid; request a new one') }, null);
      await openResetLink();

      await userEvent.type(await screen.findByLabelText('New Access Key'), 'BrandNewPassword9!');
      await userEvent.type(screen.getByLabelText('Confirm New Access Key'), 'BrandNewPassword9!');
      await userEvent.click(screen.getByRole('button', { name: /set access key/i }));

      expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument();
    });
  });
});
