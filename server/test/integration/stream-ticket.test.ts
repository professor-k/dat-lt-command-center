import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, testApp, tokenFor } from '../helpers/fixtures.js';

/**
 * EventSource cannot set headers, so whatever authorises the stream travels in the query
 * string, where access logs pick it up. A ticket is what travels there instead of the
 * session: short-lived, and good for nothing else.
 */
describe('stream tickets', () => {
  let app: FastifyInstance;
  let engineer: string;

  beforeAll(async () => {
    app = await testApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    engineer = await tokenFor(app, 'ENGINEER');
  });

  const ticketFor = async (token: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/stream-ticket', headers: auth(token) });
    return response.json().ticket as string;
  };

  it('issues a ticket to a signed-in user', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/stream-ticket', headers: auth(engineer) });

    expect(response.statusCode).toBe(200);
    expect(response.json().ticket).toEqual(expect.any(String));
  });

  it('refuses to issue one without a session', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/stream-ticket' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses to issue one to a revoked session', async () => {
    const admin = await tokenFor(app, 'ADMIN');
    const account = await prisma.user.findUniqueOrThrow({ where: { email: 'engineer@test.aero' } });
    await app.inject({
      method: 'PATCH',
      url: `/api/auth/users/${account.id}`,
      headers: auth(admin),
      payload: { active: false },
    });

    const response = await app.inject({ method: 'POST', url: '/api/auth/stream-ticket', headers: auth(engineer) });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a ticket used as a session token', async () => {
    const ticket = await ticketFor(engineer);

    // The whole point of a separate credential: it opens the stream and nothing else.
    const response = await app.inject({ method: 'GET', url: '/api/fleet', headers: auth(ticket) });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a session token offered as a stream ticket', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stream?ticket=${encodeURIComponent(engineer)}` });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a stream opened with no credential at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/stream' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a stream opened with a made-up ticket', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/stream?ticket=not-a-real-ticket' });
    expect(response.statusCode).toBe(401);
  });
});
