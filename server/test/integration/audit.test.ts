import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createAircraft, createStation, createUser, testApp, tokenFor } from '../helpers/fixtures.js';

/** Who changed what, and when — across every entity, not just defects. */
describe('audit trail', () => {
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

  const audit = async (query = '') =>
    (await app.inject({ method: 'GET', url: `/api/audit${query}`, headers: auth(admin) })).json();

  describe('recording', () => {
    it('records who moved an aircraft, and between which stations', async () => {
      const mxp = await createStation('MXP', 'Milan');
      const fco = await createStation('FCO', 'Rome');
      await createAircraft('LY-MOVE', { stationId: mxp.id });

      await app.inject({
        method: 'PATCH',
        url: '/api/fleet/LY-MOVE',
        headers: auth(admin),
        payload: { stationCode: 'FCO' },
      });

      const { entries } = await audit('?entityType=Aircraft');
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('aircraft.moved');
      expect(entries[0].actorEmail).toBe('admin@test.aero');
      expect(entries[0].actorRole).toBe('ADMIN');
      expect(entries[0].summary).toContain('MXP → FCO');
      expect(entries[0].before).toMatchObject({ station: 'MXP' });
      expect(entries[0].after).toMatchObject({ station: 'FCO' });
      expect(fco.code).toBe('FCO');
    });

    it('records a station being closed', async () => {
      await createStation('BGY', 'Bergamo');
      await app.inject({ method: 'DELETE', url: '/api/stations/BGY', headers: auth(admin) });

      const { entries } = await audit('?entityType=Station');
      expect(entries[0].action).toBe('station.closed');
      expect(entries[0].summary).toContain('BGY');
    });

    it('records a defect being raised and grounding the aircraft', async () => {
      await createAircraft('LY-GRND');
      await app.inject({
        method: 'POST',
        url: '/api/defects',
        headers: auth(admin),
        payload: { registration: 'LY-GRND', ataChapter: '36', title: 'Bleed leak', category: 'CRITICAL' },
      });

      const { entries } = await audit('?entityType=Defect');
      expect(entries[0].action).toBe('defect.created');
      expect(entries[0].summary).toContain('aircraft grounded');
    });

    it('records a deferral with its MEL reference', async () => {
      await createAircraft('LY-DEF');
      const raised = await app.inject({
        method: 'POST',
        url: '/api/defects',
        headers: auth(admin),
        payload: { registration: 'LY-DEF', ataChapter: '33', title: 'Dome light', category: 'CAT_B' },
      });

      await app.inject({
        method: 'POST',
        url: `/api/defects/${raised.json().defect.id}/defer`,
        headers: auth(admin),
        payload: { deferralRef: 'MEL-33-41-02B', expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString() },
      });

      const { entries } = await audit('?action=defect.deferred');
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toContain('MEL-33-41-02B');
    });

    it('records a user being deactivated', async () => {
      const victim = await createUser('ENGINEER');
      await app.inject({
        method: 'PATCH',
        url: `/api/auth/users/${victim.id}`,
        headers: auth(admin),
        payload: { active: false },
      });

      const { entries } = await audit('?entityType=User');
      expect(entries[0].action).toBe('user.deactivated');
      expect(entries[0].summary).toContain(victim.email);
    });

    it('never writes a password into the log', async () => {
      const victim = await createUser('VIEWER');
      await app.inject({
        method: 'POST',
        url: `/api/auth/users/${victim.id}/password`,
        headers: auth(admin),
        payload: { newPassword: 'SuperSecret12345!' },
      });

      const { entries } = await audit();
      expect(entries[0].action).toBe('user.password_reset');
      expect(JSON.stringify(entries)).not.toContain('SuperSecret12345!');
    });

    it('records baseline edits', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/history',
        headers: auth(admin),
        payload: { year: 2026, month: 5, count: 12 },
      });

      const { entries } = await audit('?entityType=DefectHistory');
      expect(entries[0].summary).toContain('2026-05');
      expect(entries[0].after).toMatchObject({ count: 12 });
    });

    it('writes nothing when the change was refused', async () => {
      const aircraft = await createAircraft('LY-KEEP');
      await prisma.defect.create({
        data: { reference: 'DEF-X-1', aircraftId: aircraft.id, ataChapter: '36', title: 'On file' },
      });

      const refused = await app.inject({ method: 'DELETE', url: '/api/fleet/LY-KEEP', headers: auth(admin) });
      expect(refused.statusCode).toBe(409);

      const { entries } = await audit('?action=aircraft.deleted');
      expect(entries).toHaveLength(0);
    });

    it('records opening a station impediment', async () => {
      const station = await createStation('NAP', 'Naples');

      const opened = await app.inject({
        method: 'POST',
        url: `/api/stations/${station.code}/impediments`,
        headers: auth(admin),
        payload: { category: 'Manpower', description: 'B1 engineer sick, night shift uncovered' },
      });
      expect(opened.statusCode).toBe(201);

      const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Impediment' } });
      expect(entry.action).toBe('impediment.opened');
      expect(entry.summary).toContain('NAP');
      expect(entry.summary).toContain('Manpower');
      expect(entry.entityId).toBe(opened.json().impediment.id);
    });

    it('records resolving a station impediment', async () => {
      const station = await createStation('BLQ', 'Bologna');
      const opened = await app.inject({
        method: 'POST',
        url: `/api/stations/${station.code}/impediments`,
        headers: auth(admin),
        payload: { category: 'Tooling', description: 'Torque wrench out for calibration' },
      });

      await app.inject({
        method: 'PATCH',
        url: `/api/stations/impediments/${opened.json().impediment.id}`,
        headers: auth(admin),
        payload: { status: 'RESOLVED' },
      });

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: 'Impediment', action: 'impediment.resolved' },
      });
      expect(entry.summary).toContain('OPEN → RESOLVED');
      expect((entry.after as { status?: string }).status).toBe('RESOLVED');
    });
  });

  describe('reading', () => {
    const makeEntries = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        await app.inject({
          method: 'PUT',
          url: '/api/history',
          headers: auth(admin),
          payload: { year: 2026, month: (i % 12) + 1, count: i },
        });
      }
    };

    it('is ADMIN only', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');
      expect((await app.inject({ method: 'GET', url: '/api/audit', headers: auth(engineer) })).statusCode).toBe(403);
    });

    it('returns newest first', async () => {
      await makeEntries(3);
      const { entries } = await audit();
      const times = entries.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('pages with a cursor', async () => {
      await makeEntries(12);

      const first = await audit('?take=5');
      expect(first.entries).toHaveLength(5);
      expect(first.nextCursor).toBeTruthy();

      const second = await audit(`?take=5&cursor=${first.nextCursor}`);
      expect(second.entries).toHaveLength(5);

      // No overlap between pages.
      const firstIds = first.entries.map((e: { id: string }) => e.id);
      const secondIds = second.entries.map((e: { id: string }) => e.id);
      expect(firstIds.filter((id: string) => secondIds.includes(id))).toHaveLength(0);

      const last = await audit(`?take=5&cursor=${second.nextCursor}`);
      expect(last.entries).toHaveLength(2);
      expect(last.nextCursor).toBeNull();
    });

    it('filters to one entity', async () => {
      await createStation('VCE', 'Venice');
      await createAircraft('LY-FIL');
      await app.inject({
        method: 'PATCH',
        url: '/api/fleet/LY-FIL',
        headers: auth(admin),
        payload: { operationalStatus: 'MAINTENANCE' },
      });

      const { entries } = await audit('?entityType=Aircraft');
      expect(entries).toHaveLength(1);
      expect(entries[0].entityType).toBe('Aircraft');
    });

    it('rejects an unknown entity type', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/audit?entityType=Nonsense', headers: auth(admin) });
      expect(response.statusCode).toBe(400);
    });
  });
});
