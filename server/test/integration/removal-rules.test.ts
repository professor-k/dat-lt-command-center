import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createAircraft, createDefect, createStation, testApp, tokenFor } from '../helpers/fixtures.js';

/**
 * Nothing carrying a maintenance record may be deleted — the technical log has to outlive
 * the UI that renders it. Both refusals are 409s that name what is in the way.
 */
describe('removal rules', () => {
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

  describe('aircraft', () => {
    it('refuses to delete an airframe holding a defect', async () => {
      const aircraft = await createAircraft('LY-HOLD');
      await createDefect(aircraft.id);

      const response = await app.inject({ method: 'DELETE', url: '/api/fleet/LY-HOLD', headers: auth(admin) });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('Conflict');
      expect(response.json().message).toMatch(/STORED/);
      expect(await prisma.aircraft.count()).toBe(1);
    });

    it('refuses even when the defect is closed — history still counts', async () => {
      const aircraft = await createAircraft('LY-CLSD');
      await createDefect(aircraft.id, { status: 'CLOSED' });

      const response = await app.inject({ method: 'DELETE', url: '/api/fleet/LY-CLSD', headers: auth(admin) });

      expect(response.statusCode).toBe(409);
      expect(await prisma.aircraft.count()).toBe(1);
    });

    it('deletes an airframe with no technical record', async () => {
      await createAircraft('LY-CLEAN');

      const response = await app.inject({ method: 'DELETE', url: '/api/fleet/LY-CLEAN', headers: auth(admin) });

      expect(response.statusCode).toBe(204);
      expect(await prisma.aircraft.count()).toBe(0);
    });

    it('404s for an unknown registration', async () => {
      const response = await app.inject({ method: 'DELETE', url: '/api/fleet/LY-NONE', headers: auth(admin) });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('stations', () => {
    it('refuses to close a station that still hosts aircraft', async () => {
      const station = await createStation('MXP', 'Milan');
      await createAircraft('LY-BASE', { stationId: station.id });

      const response = await app.inject({ method: 'DELETE', url: '/api/stations/MXP', headers: auth(admin) });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toMatch(/move them/i);
      expect(await prisma.station.count()).toBe(1);
    });

    it('closes a station once its aircraft have moved', async () => {
      const mxp = await createStation('MXP', 'Milan');
      const fco = await createStation('FCO', 'Rome');
      await createAircraft('LY-MOVE', { stationId: mxp.id });

      const moved = await app.inject({
        method: 'PATCH',
        url: '/api/fleet/LY-MOVE',
        headers: auth(admin),
        payload: { stationCode: fco.code },
      });
      expect(moved.statusCode).toBe(200);

      const response = await app.inject({ method: 'DELETE', url: '/api/stations/MXP', headers: auth(admin) });
      expect(response.statusCode).toBe(204);
    });

    it('takes the impediment log down with the station', async () => {
      const station = await createStation('BGY', 'Bergamo');
      await prisma.impediment.create({
        data: { stationId: station.id, category: 'Tooling', description: 'Calibration overdue' },
      });

      expect((await app.inject({ method: 'DELETE', url: '/api/stations/BGY', headers: auth(admin) })).statusCode).toBe(204);
      expect(await prisma.impediment.count()).toBe(0);
    });
  });

  describe('predictive alerts', () => {
    it('withdraws outright — predictions are estimates, not records', async () => {
      const aircraft = await createAircraft('LY-PRED');
      const alert = await prisma.predictiveAlert.create({
        data: {
          aircraftId: aircraft.id,
          component: 'Hydraulic Pump',
          ataChapter: '29',
          dueInDays: 20,
          recommendation: 'Replace at next night stop',
        },
      });

      const response = await app.inject({ method: 'DELETE', url: `/api/alerts/${alert.id}`, headers: auth(admin) });

      expect(response.statusCode).toBe(204);
      expect(await prisma.predictiveAlert.count()).toBe(0);
    });
  });
});
