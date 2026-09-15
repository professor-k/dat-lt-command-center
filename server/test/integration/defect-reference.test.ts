import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createAircraft, testApp, tokenFor } from '../helpers/fixtures.js';

/**
 * Defect references are handed out in sequence per year, and the column is unique. Two
 * engineers raising a defect at the same moment must not be able to pick the same number —
 * the loser of that race does not get a retry, they get an error and a lost defect report.
 */
describe('defect references', () => {
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
    await createAircraft('LY-REF');
  });

  const raise = (title: string) =>
    app.inject({
      method: 'POST',
      url: '/api/defects',
      headers: auth(engineer),
      payload: { registration: 'LY-REF', ataChapter: '36', title, category: 'CAT_C' },
    });

  it('numbers defects in sequence', async () => {
    const year = new Date().getFullYear();

    expect((await raise('First defect')).json().defect.reference).toBe(`DEF-${year}-0001`);
    expect((await raise('Second defect')).json().defect.reference).toBe(`DEF-${year}-0002`);
    expect((await raise('Third defect')).json().defect.reference).toBe(`DEF-${year}-0003`);
  });

  it('gives every defect raised at once its own reference', async () => {
    const attempts = 10;

    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, i) => raise(`Concurrent defect ${i + 1}`)),
    );

    // Nothing is dropped: every caller gets a defect back, not a unique-constraint error.
    expect(responses.map((r) => r.statusCode)).toEqual(Array(attempts).fill(201));

    const stored = await prisma.defect.findMany({ select: { reference: true } });
    expect(stored).toHaveLength(attempts);
    expect(new Set(stored.map((d) => d.reference)).size).toBe(attempts);
  });

  it('leaves no gaps in the sequence when defects are raised at once', async () => {
    const year = new Date().getFullYear();
    const attempts = 5;

    await Promise.all(Array.from({ length: attempts }, (_, i) => raise(`Defect ${i + 1}`)));

    const stored = await prisma.defect.findMany({ orderBy: { reference: 'asc' }, select: { reference: true } });
    expect(stored.map((d) => d.reference)).toEqual([
      `DEF-${year}-0001`,
      `DEF-${year}-0002`,
      `DEF-${year}-0003`,
      `DEF-${year}-0004`,
      `DEF-${year}-0005`,
    ]);
  });

  it('still grounds the aircraft when a CRITICAL defect wins a race', async () => {
    const responses = await Promise.all([
      raise('Routine snag'),
      app.inject({
        method: 'POST',
        url: '/api/defects',
        headers: auth(engineer),
        payload: { registration: 'LY-REF', ataChapter: '36', title: 'No-go snag', category: 'CRITICAL' },
      }),
      raise('Another routine snag'),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201]);

    const aircraft = await prisma.aircraft.findUniqueOrThrow({ where: { registration: 'LY-REF' } });
    expect(aircraft.operationalStatus).toBe('AOG');
  });
});
