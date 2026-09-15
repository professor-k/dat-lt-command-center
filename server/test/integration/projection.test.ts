import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createAircraft, testApp, tokenFor } from '../helpers/fixtures.js';

/**
 * The defect baseline is reference data an engineer maintains by hand, and the year-end
 * projection on the overview is built from it. These are wired together across two routes,
 * so the link is worth holding in place.
 */
describe('defect baseline and projection', () => {
  let app: FastifyInstance;
  let engineer: string;
  const year = new Date().getFullYear();

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

  const overview = async () =>
    (await app.inject({ method: 'GET', url: '/api/overview', headers: auth(engineer) })).json();

  const setMonth = (month: number, count: number) =>
    app.inject({ method: 'PUT', url: '/api/history', headers: auth(engineer), payload: { year, month, count } });

  it('raises the projection when the baseline grows', async () => {
    await setMonth(1, 10);
    const before = (await overview()).projectedDefects;

    await setMonth(2, 200);
    const after = (await overview()).projectedDefects;

    expect(after).toBeGreaterThan(before);
  });

  it('drops the month back out of the baseline when cleared', async () => {
    await setMonth(3, 50);
    expect((await app.inject({ method: 'GET', url: '/api/history', headers: auth(engineer) })).json().total).toBe(50);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/history/${year}/3`,
      headers: auth(engineer),
    });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/history', headers: auth(engineer) })).json().total).toBe(0);
  });

  it('upserts rather than duplicating a month', async () => {
    await setMonth(4, 5);
    await setMonth(4, 9);

    const history = (await app.inject({ method: 'GET', url: '/api/history', headers: auth(engineer) })).json();
    expect(history.months).toHaveLength(1);
    expect(history.total).toBe(9);
  });

  it('rejects an impossible month', async () => {
    expect((await setMonth(13, 5)).statusCode).toBe(400);
    expect((await setMonth(0, 5)).statusCode).toBe(400);
  });

  it('404s when clearing a month that was never recorded', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/history/${year}/11`,
      headers: auth(engineer),
    });
    expect(response.statusCode).toBe(404);
  });

  it('counts open defects and AOG aircraft on the overview', async () => {
    const aircraft = await createAircraft('LY-KPI');
    await app.inject({
      method: 'POST',
      url: '/api/defects',
      headers: auth(engineer),
      payload: { registration: aircraft.registration, ataChapter: '36', title: 'No-go', category: 'CRITICAL' },
    });

    const data = await overview();
    expect(data.openDefects).toBe(1);
    expect(data.criticalDefects).toBe(1);
    expect(data.fleet.aog).toBe(1);
    expect(data.fleet.availability).toBe(0);
  });
});
