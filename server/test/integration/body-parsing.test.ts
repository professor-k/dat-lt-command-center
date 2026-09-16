import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, testApp, tokenFor } from '../helpers/fixtures.js';

const json = (token?: string) => ({
  'Content-Type': 'application/json',
  ...(token ? auth(token) : {}),
});

/**
 * A client that announces JSON and sends nothing is not making a malformed request — it is
 * making an empty one, which several endpoints here expect. Fastify's default refuses it
 * before the route runs, and that refusal silently broke the stream ticket, the session
 * renewal and signing out for months.
 */
describe('empty JSON bodies', () => {
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

  it('issues a stream ticket for a POST that declares JSON and sends none', async () => {
    const token = await tokenFor(app, 'VIEWER');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/stream-ticket',
      headers: json(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ticket).toBeTruthy();
  });

  it('signs out on an empty body, so the session is really revoked', async () => {
    const token = await tokenFor(app, 'ENGINEER');

    const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: json(token) });
    expect(response.statusCode).toBe(204);

    // The point of the endpoint: the token it was called with is now dead.
    const after = await app.inject({ method: 'GET', url: '/api/fleet', headers: auth(token) });
    expect(after.statusCode).toBe(401);
  });

  it('renews a session on an empty body', async () => {
    const token = await tokenFor(app, 'VIEWER');

    const response = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: json(token) });

    expect(response.statusCode).toBe(200);
    expect(response.json().token).toBeTruthy();
  });

  it('still reads a body that is actually sent', async () => {
    const token = await tokenFor(app, 'ADMIN');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/users',
      headers: json(token),
      payload: { email: 'new@test.aero', name: 'New Operator', role: 'VIEWER', password: 'GoodPassword1!' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().user.email).toBe('new@test.aero');
  });

  it('still refuses malformed JSON', async () => {
    const token = await tokenFor(app, 'ADMIN');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/users',
      headers: json(token),
      payload: '{"email": "broken",',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('BadRequest');
  });

  it('answers the route rather than the parser when the body is required but empty', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: json() });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/email and password/i);
  });
});
