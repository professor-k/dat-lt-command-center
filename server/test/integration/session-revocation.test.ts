import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createUser, testApp, tokenFor } from '../helpers/fixtures.js';

/**
 * Access Control is where an administrator goes when someone should no longer have access,
 * so what it changes has to take effect on the next request rather than whenever the
 * twelve-hour token happens to run out. Everything here is about a token that is still
 * perfectly valid on its signature and must nonetheless be refused.
 */
describe('session revocation', () => {
  let app: FastifyInstance;
  let admin: string;

  beforeAll(async () => {
    app = await testApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await tokenFor(app, 'ADMIN');
  });

  const fleet = (token: string) => app.inject({ method: 'GET', url: '/api/fleet', headers: auth(token) });
  const listUsers = (token: string) => app.inject({ method: 'GET', url: '/api/auth/users', headers: auth(token) });

  describe('account state', () => {
    it('refuses a deactivated account on its existing token', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');
      const account = await prisma.user.findUniqueOrThrow({ where: { email: 'engineer@test.aero' } });
      expect((await fleet(engineer)).statusCode).toBe(200);

      const deactivate = await app.inject({
        method: 'PATCH',
        url: `/api/auth/users/${account.id}`,
        headers: auth(admin),
        payload: { active: false },
      });
      expect(deactivate.statusCode).toBe(200);

      expect((await fleet(engineer)).statusCode).toBe(401);
    });

    it('lets a reactivated account back in on the same token', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');
      const account = await prisma.user.findUniqueOrThrow({ where: { email: 'engineer@test.aero' } });

      await app.inject({ method: 'PATCH', url: `/api/auth/users/${account.id}`, headers: auth(admin), payload: { active: false } });
      expect((await fleet(engineer)).statusCode).toBe(401);

      await app.inject({ method: 'PATCH', url: `/api/auth/users/${account.id}`, headers: auth(admin), payload: { active: true } });
      expect((await fleet(engineer)).statusCode).toBe(200);
    });
  });

  describe('role changes', () => {
    it('takes admin powers away from a demoted administrator immediately', async () => {
      const second = await createUser('ADMIN', 'admin2@test.aero');
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: second.email, password: 'TestPassword123!' },
      });
      const secondToken = login.json().token;
      expect((await listUsers(secondToken)).statusCode).toBe(200);

      const demote = await app.inject({
        method: 'PATCH',
        url: `/api/auth/users/${second.id}`,
        headers: auth(admin),
        payload: { role: 'VIEWER' },
      });
      expect(demote.statusCode).toBe(200);

      expect((await listUsers(secondToken)).statusCode).toBe(403);
    });

    it('grants a promoted user their new powers without a fresh sign-in', async () => {
      const viewer = await tokenFor(app, 'VIEWER');
      const account = await prisma.user.findUniqueOrThrow({ where: { email: 'viewer@test.aero' } });
      expect((await listUsers(viewer)).statusCode).toBe(403);

      await app.inject({ method: 'PATCH', url: `/api/auth/users/${account.id}`, headers: auth(admin), payload: { role: 'ADMIN' } });

      expect((await listUsers(viewer)).statusCode).toBe(200);
    });

    it('records the actor at the role they hold now, not the one their token was minted with', async () => {
      const second = await createUser('ENGINEER', 'engineer2@test.aero');
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: second.email, password: 'TestPassword123!' },
      });
      const engineerToken = login.json().token;

      await app.inject({ method: 'PATCH', url: `/api/auth/users/${second.id}`, headers: auth(admin), payload: { role: 'ADMIN' } });

      await app.inject({
        method: 'POST',
        url: '/api/stations',
        headers: auth(engineerToken),
        payload: { code: 'FCO', city: 'Rome' },
      });

      const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Station' } });
      expect(entry.actorRole).toBe('ADMIN');
    });
  });

  describe('passwords and sign-out', () => {
    it('signs other sessions out when the password changes, and keeps this one', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');
      const otherDevice = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'engineer@test.aero', password: 'TestPassword123!' },
      });
      const otherToken = otherDevice.json().token;

      const change = await app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: auth(engineer),
        payload: { currentPassword: 'TestPassword123!', newPassword: 'BrandNewPassword9!' },
      });
      expect(change.statusCode).toBe(200);

      const replacement = change.json().token;
      expect(replacement).toBeTruthy();
      expect((await fleet(replacement)).statusCode).toBe(200);
      expect((await fleet(engineer)).statusCode).toBe(401);
      expect((await fleet(otherToken)).statusCode).toBe(401);
    });

    it('signs a user out everywhere when an admin resets their password', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');
      const account = await prisma.user.findUniqueOrThrow({ where: { email: 'engineer@test.aero' } });

      const reset = await app.inject({
        method: 'POST',
        url: `/api/auth/users/${account.id}/password`,
        headers: auth(admin),
        payload: { newPassword: 'ResetPassword9!' },
      });
      expect(reset.statusCode).toBe(204);

      expect((await fleet(engineer)).statusCode).toBe(401);
      // The administrator who performed the reset is unaffected.
      expect((await fleet(admin)).statusCode).toBe(200);
    });

    it('invalidates the token on sign-out', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');

      const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(engineer) });
      expect(logout.statusCode).toBe(204);

      expect((await fleet(engineer)).statusCode).toBe(401);
    });

    it('lets a signed-out user back in with a new sign-in', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');
      await app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(engineer) });

      const again = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'engineer@test.aero', password: 'TestPassword123!' },
      });
      expect(again.statusCode).toBe(200);
      expect((await fleet(again.json().token)).statusCode).toBe(200);
    });
  });

  describe('refresh', () => {
    it('hands a still-valid session a fresh token', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');

      const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: auth(engineer) });
      expect(refreshed.statusCode).toBe(200);
      expect((await fleet(refreshed.json().token)).statusCode).toBe(200);
    });

    it('refuses to renew a revoked session', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');
      const account = await prisma.user.findUniqueOrThrow({ where: { email: 'engineer@test.aero' } });
      await app.inject({ method: 'PATCH', url: `/api/auth/users/${account.id}`, headers: auth(admin), payload: { active: false } });

      const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: auth(engineer) });
      expect(refreshed.statusCode).toBe(401);
    });
  });

  it('still refuses a token that was never valid', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/fleet', headers: auth('not-a-token') });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a token for an account that no longer exists', async () => {
    const engineer = await tokenFor(app, 'ENGINEER');
    // Not reachable through the API — accounts are deactivated, never deleted — but the
    // guard should not fall over if a row goes missing.
    await prisma.user.delete({ where: { email: 'engineer@test.aero' } });

    expect((await fleet(engineer)).statusCode).toBe(401);
  });

  it('leaves an untouched session working', async () => {
    const engineer = await tokenFor(app, 'ENGINEER');
    await bcrypt.compare('x', '$2a$04$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    expect((await fleet(engineer)).statusCode).toBe(200);
  });
});
