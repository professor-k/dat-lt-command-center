import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createUser, testApp, tokenFor } from '../helpers/fixtures.js';

/**
 * Self-service reset. Mail delivery is not configured in the test environment, which is
 * itself the case worth pinning down: the endpoint must stay quiet about who has an account
 * whether or not it can actually send anything.
 */
describe('password reset', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await testApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  const forgot = (email: string) => app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email } });

  const reset = (token: string, newPassword: string) =>
    app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, newPassword } });

  const login = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  /** Stands in for the link a mail transport would deliver. */
  const issueToken = async (userId: string, options: { expiresAt?: Date; usedAt?: Date } = {}) => {
    const token = 'test-reset-token-' + Math.random().toString(36).slice(2);
    await prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
        usedAt: options.usedAt ?? null,
      },
    });
    return token;
  };

  describe('asking for a link', () => {
    it('answers the same way for a registered address and an unknown one', async () => {
      await createUser('ENGINEER', 'known@test.aero');

      const known = await forgot('known@test.aero');
      const unknown = await forgot('nobody@test.aero');

      expect(known.statusCode).toBe(200);
      expect(unknown.statusCode).toBe(200);
      expect(known.json()).toEqual(unknown.json());
    });

    it('issues no token when mail cannot be delivered', async () => {
      const user = await createUser('ENGINEER', 'quiet@test.aero');

      await forgot(user.email);

      // Nothing to steal from the database if nothing can reach the person anyway.
      expect(await prisma.passwordResetToken.count()).toBe(0);
    });

    it('says plainly that an administrator is the way back in', async () => {
      const response = await forgot('anyone@test.aero');
      expect(response.json().message).toContain('administrator');
    });

    it('rejects an address that is not one', async () => {
      const response = await forgot('not-an-address');
      expect(response.statusCode).toBe(400);
    });
  });

  describe('using a link', () => {
    it('sets a new password and signs the account out everywhere', async () => {
      const user = await createUser('ENGINEER', 'reset@test.aero');
      const existingSession = (await login(user.email, 'TestPassword123!')).json().token;
      const token = await issueToken(user.id);

      const response = await reset(token, 'CompletelyNewPass9!');
      expect(response.statusCode).toBe(204);

      expect((await login(user.email, 'CompletelyNewPass9!')).statusCode).toBe(200);
      expect((await login(user.email, 'TestPassword123!')).statusCode).toBe(401);

      const stillIn = await app.inject({ method: 'GET', url: '/api/fleet', headers: auth(existingSession) });
      expect(stillIn.statusCode).toBe(401);
    });

    it('refuses a token that has already been spent', async () => {
      const user = await createUser('ENGINEER', 'once@test.aero');
      const token = await issueToken(user.id);

      expect((await reset(token, 'FirstNewPassword9!')).statusCode).toBe(204);

      const second = await reset(token, 'SecondNewPassword9!');
      expect(second.statusCode).toBe(400);
      expect((await login(user.email, 'SecondNewPassword9!')).statusCode).toBe(401);
    });

    it('refuses an expired token', async () => {
      const user = await createUser('ENGINEER', 'late@test.aero');
      const token = await issueToken(user.id, { expiresAt: new Date(Date.now() - 1000) });

      expect((await reset(token, 'TooLatePassword9!')).statusCode).toBe(400);
      expect((await login(user.email, 'TestPassword123!')).statusCode).toBe(200);
    });

    it('refuses a token for a deactivated account', async () => {
      const user = await createUser('ENGINEER', 'gone@test.aero');
      const token = await issueToken(user.id);
      await prisma.user.update({ where: { id: user.id }, data: { active: false } });

      expect((await reset(token, 'NotComingBack9!')).statusCode).toBe(400);
    });

    it('refuses a made-up token', async () => {
      await createUser('ENGINEER', 'nope@test.aero');
      expect((await reset('completely-made-up-token', 'InventedPassword9!')).statusCode).toBe(400);
    });

    it('says the same thing however the token is bad', async () => {
      const user = await createUser('ENGINEER', 'same@test.aero');
      const expired = await issueToken(user.id, { expiresAt: new Date(Date.now() - 1000) });

      const invented = await reset('completely-made-up-token', 'InventedPassword9!');
      const stale = await reset(expired, 'StalePassword9!');

      expect(stale.json()).toEqual(invented.json());
    });

    it('spends every other outstanding link for the account', async () => {
      const user = await createUser('ENGINEER', 'many@test.aero');
      const first = await issueToken(user.id);
      const second = await issueToken(user.id);

      expect((await reset(first, 'FirstNewPassword9!')).statusCode).toBe(204);

      expect((await reset(second, 'SecondNewPassword9!')).statusCode).toBe(400);
      expect(await prisma.passwordResetToken.count({ where: { usedAt: null } })).toBe(0);
    });

    it('stores no usable copy of the token', async () => {
      const user = await createUser('ENGINEER', 'hashed@test.aero');
      const token = await issueToken(user.id);

      const stored = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
      expect(stored.tokenHash).not.toBe(token);
      expect(await reset(stored.tokenHash, 'FromTheDatabase9!')).toMatchObject({ statusCode: 400 });
    });

    it('rejects a new password that is too short', async () => {
      const user = await createUser('ENGINEER', 'short@test.aero');
      const token = await issueToken(user.id);

      expect((await reset(token, 'short')).statusCode).toBe(400);
      // The link survives a typo.
      expect((await reset(token, 'LongEnoughPassword9!')).statusCode).toBe(204);
    });
  });

  it('leaves the administrator reset working as the supported path', async () => {
    const admin = await tokenFor(app, 'ADMIN');
    const user = await createUser('ENGINEER', 'helped@test.aero');

    const response = await app.inject({
      method: 'POST',
      url: `/api/auth/users/${user.id}/password`,
      headers: auth(admin),
      payload: { newPassword: 'AdminSetPassword9!' },
    });

    expect(response.statusCode).toBe(204);
    expect(await bcrypt.compare('AdminSetPassword9!', (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });
});
