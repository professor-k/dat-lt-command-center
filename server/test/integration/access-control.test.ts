import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createAircraft, testApp, tokenFor } from '../helpers/fixtures.js';

/** Every mutating route is gated; the guards are what keep a VIEWER read-only. */
describe('access control', () => {
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

  it('rejects an unauthenticated request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/fleet' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('Unauthorized');
  });

  it('rejects a malformed token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/fleet', headers: auth('not-a-jwt') });
    expect(response.statusCode).toBe(401);
  });

  it('lets a VIEWER read', async () => {
    const viewer = await tokenFor(app, 'VIEWER');
    const response = await app.inject({ method: 'GET', url: '/api/fleet', headers: auth(viewer) });
    expect(response.statusCode).toBe(200);
  });

  it('stops a VIEWER writing', async () => {
    const viewer = await tokenFor(app, 'VIEWER');
    const response = await app.inject({
      method: 'POST',
      url: '/api/fleet',
      headers: auth(viewer),
      payload: { registration: 'LY-NOPE' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(/ADMIN or ENGINEER/);
    expect(await prisma.aircraft.count()).toBe(0);
  });

  it('stops an ENGINEER deleting an airframe — that is ADMIN only', async () => {
    await createAircraft('LY-DEL');
    const engineer = await tokenFor(app, 'ENGINEER');

    const response = await app.inject({ method: 'DELETE', url: '/api/fleet/LY-DEL', headers: auth(engineer) });

    expect(response.statusCode).toBe(403);
    expect(await prisma.aircraft.count()).toBe(1);
  });

  it('lets an ENGINEER raise a defect', async () => {
    await createAircraft('LY-ENG');
    const engineer = await tokenFor(app, 'ENGINEER');

    const response = await app.inject({
      method: 'POST',
      url: '/api/defects',
      headers: auth(engineer),
      payload: { registration: 'LY-ENG', ataChapter: '36', title: 'Valve sticking' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('stops a non-admin opening a station', async () => {
    const engineer = await tokenFor(app, 'ENGINEER');
    const response = await app.inject({
      method: 'POST',
      url: '/api/stations',
      headers: auth(engineer),
      payload: { code: 'VCE', city: 'Venice' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses the event stream without a valid token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/stream' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/stream?token=bogus' })).statusCode).toBe(401);
  });

  it('rejects bad credentials without revealing whether the account exists', async () => {
    await tokenFor(app, 'ADMIN');

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@test.aero', password: 'wrong' },
    });
    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@test.aero', password: 'wrong' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    expect(noSuchUser.json().message).toBe(wrongPassword.json().message);
  });
});
