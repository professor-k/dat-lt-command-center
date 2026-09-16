import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createUser, tokenFor } from '../helpers/fixtures.js';

/**
 * The only suite that builds the app with throttling on, because everything else would
 * spend its budget on setup. What is worth protecting here is not that a limit exists but
 * what it is counted against: an internal tool is reached through a handful of office
 * addresses, so a limit keyed on the address alone would have a shift throttle itself out.
 */
describe('throttling', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false, rateLimiting: true });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('counts requests against the account, not the address it came from', async () => {
    const engineer = await tokenFor(app, 'ENGINEER');
    const viewer = await tokenFor(app, 'VIEWER');

    // Both tokens arrive from the same address, as they would from one office.
    for (let i = 0; i < 40; i++) {
      await app.inject({ method: 'GET', url: '/api/fleet', headers: auth(engineer) });
    }

    const other = await app.inject({ method: 'GET', url: '/api/fleet', headers: auth(viewer) });
    expect(other.statusCode).toBe(200);
    expect(other.headers['x-ratelimit-remaining']).toBe('299');
  });

  it('will not let a forged token spend another account’s budget', async () => {
    const forge = (sub: string) =>
      `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(
        JSON.stringify({ sub }),
      ).toString('base64url')}.not-a-signature`;

    // Two different subjects. Were the key taken from the claims without checking the
    // signature, these would be two budgets; because the signature is verified, both are
    // strangers at the same address and share one.
    const first = await app.inject({ method: 'GET', url: '/api/fleet', headers: auth(forge('account-one')) });
    const second = await app.inject({ method: 'GET', url: '/api/fleet', headers: auth(forge('account-two')) });

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(Number(second.headers['x-ratelimit-remaining'])).toBe(Number(first.headers['x-ratelimit-remaining']) - 1);
  });

  it('throttles guesses at one account without locking out the address', async () => {
    await createUser('ENGINEER', 'target@test.aero');
    await createUser('VIEWER', 'colleague@test.aero');

    const guess = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'target@test.aero', password: 'wrong-password' },
      });

    let lastStatus = 0;
    for (let i = 0; i < 11; i++) lastStatus = (await guess()).statusCode;
    expect(lastStatus).toBe(429);

    // The colleague shares the address but not the budget, and can still sign in.
    const colleague = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'colleague@test.aero', password: 'TestPassword123!' },
    });
    expect(colleague.statusCode).toBe(200);
  });
});

/**
 * Every expected failure is answered by the route that knows about it, so reaching the
 * error handler means a bug. What matters is that the bug does not leave by the front door.
 */
describe('unhandled errors', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false, rateLimiting: false });
    app.get('/api/boom', async () => {
      throw new Error('Invalid `prisma.user.findUnique()`: column User.secret_column');
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('answers with a reference instead of the internal detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/boom' });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBe('InternalServerError');
    expect(body.message).not.toContain('secret_column');
    expect(body.message).toContain(body.reference);
  });

  it('lets a refusal that carries its own status through', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
  });
});
