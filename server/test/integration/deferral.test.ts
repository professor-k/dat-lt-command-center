import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createAircraft, createDefect, testApp, tokenFor } from '../helpers/fixtures.js';

const DAY = 86_400_000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

/** MEL deferral and the rectification deadlines it moves. */
describe('MEL deferral and overdue', () => {
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

  const raise = async (category = 'CAT_C', registration = 'LY-MEL') => {
    await prisma.aircraft.upsert({
      where: { registration },
      create: { registration, model: 'ATR 72-600' },
      update: {},
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/defects',
      headers: auth(engineer),
      payload: { registration, ataChapter: '36', title: 'Bleed valve', category },
    });
    return response.json().defect;
  };

  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/defects/${id}`, headers: auth(engineer), payload });

  const defer = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/defects/${id}/defer`, headers: auth(engineer), payload });

  const daysBetween = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / DAY);

  describe('deadlines follow the category', () => {
    it('sets the window from the category when raised', async () => {
      expect(daysBetween((await raise('CAT_C')).dueAt)).toBe(10);
    });

    it('moves the deadline when the category is downgraded', async () => {
      const defect = await raise('CAT_D');
      expect(daysBetween(defect.dueAt)).toBe(120);

      const updated = await patch(defect.id, { category: 'CAT_A' });
      expect(updated.statusCode).toBe(200);
      // The bug this fixes: a CAT_D downgraded to CAT_A used to keep its 120-day date.
      expect(daysBetween(updated.json().defect.dueAt)).toBe(1);
    });

    it('moves the deadline when the category is upgraded', async () => {
      const defect = await raise('CAT_A');
      const updated = await patch(defect.id, { category: 'CAT_D' });
      expect(daysBetween(updated.json().defect.dueAt)).toBe(120);
    });

    it('leaves the deadline alone when something else changes', async () => {
      const defect = await raise('CAT_B');
      const updated = await patch(defect.id, { description: 'More detail' });
      expect(updated.json().defect.dueAt).toBe(defect.dueAt);
    });
  });

  describe('deferring', () => {
    it('records the reference, the engineer and the expiry', async () => {
      const defect = await raise('CAT_B');

      const response = await defer(defect.id, {
        deferralRef: 'MEL-36-11-01A',
        expiresAt: daysFromNow(30).toISOString(),
        note: 'Spare on order from MXP',
      });

      expect(response.statusCode).toBe(200);
      const deferred = response.json().defect;
      expect(deferred.status).toBe('DEFERRED');
      expect(deferred.deferralRef).toBe('MEL-36-11-01A');
      expect(deferred.deferredBy.name).toBe('ENGINEER User');
      expect(deferred.deferralNote).toBe('Spare on order from MXP');
      // The MEL expiry becomes the deadline, replacing the category window.
      expect(daysBetween(deferred.dueAt)).toBe(30);
      expect(daysBetween(deferred.deferralExpiresAt)).toBe(30);
    });

    it('refuses to defer a CRITICAL no-go defect', async () => {
      const defect = await raise('CRITICAL');

      const response = await defer(defect.id, { deferralRef: 'MEL-1', expiresAt: daysFromNow(10).toISOString() });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toMatch(/no-go/i);
      expect((await prisma.defect.findUniqueOrThrow({ where: { id: defect.id } })).status).toBe('OPEN');
    });

    it('refuses to defer a closed defect', async () => {
      const defect = await raise('CAT_C');
      await patch(defect.id, { status: 'CLOSED' });

      const response = await defer(defect.id, { deferralRef: 'MEL-2', expiresAt: daysFromNow(10).toISOString() });
      expect(response.statusCode).toBe(409);
    });

    it('refuses an expiry in the past', async () => {
      const defect = await raise('CAT_C');
      const response = await defer(defect.id, { deferralRef: 'MEL-3', expiresAt: daysFromNow(-1).toISOString() });
      expect(response.statusCode).toBe(400);
    });

    it('requires a deferral reference', async () => {
      const defect = await raise('CAT_C');
      expect((await defer(defect.id, { expiresAt: daysFromNow(10).toISOString() })).statusCode).toBe(400);
    });

    it('keeps the MEL expiry when a deferred defect is re-categorised', async () => {
      const defect = await raise('CAT_C');
      await defer(defect.id, { deferralRef: 'MEL-4', expiresAt: daysFromNow(45).toISOString() });

      const updated = await patch(defect.id, { category: 'CAT_A' });
      // Still 45 days: the deferral governs, not the new category window.
      expect(daysBetween(updated.json().defect.dueAt)).toBe(45);
    });

    it('drops the deferral when the defect is reopened', async () => {
      const defect = await raise('CAT_B');
      await defer(defect.id, { deferralRef: 'MEL-5', expiresAt: daysFromNow(45).toISOString() });

      const reopened = await patch(defect.id, { status: 'OPEN' });
      const row = reopened.json().defect;

      expect(row.status).toBe('OPEN');
      expect(row.deferralRef).toBeNull();
      expect(row.deferralExpiresAt).toBeNull();
      // Back to the category's own window.
      expect(daysBetween(row.dueAt)).toBe(3);
    });

    it('stops a VIEWER deferring', async () => {
      const defect = await raise('CAT_C');
      const viewer = await tokenFor(app, 'VIEWER');
      const response = await app.inject({
        method: 'POST',
        url: `/api/defects/${defect.id}/defer`,
        headers: auth(viewer),
        payload: { deferralRef: 'MEL-6', expiresAt: daysFromNow(10).toISOString() },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('overdue', () => {
    const makeOverdue = async (registration: string) => {
      const aircraft = await createAircraft(registration);
      const defect = await createDefect(aircraft.id);
      await prisma.defect.update({ where: { id: defect.id }, data: { dueAt: daysFromNow(-3) } });
      return defect;
    };

    it('lists only what is past its deadline and still open', async () => {
      await makeOverdue('LY-LATE');
      await raise('CAT_C', 'LY-OK'); // due in 10 days

      const response = await app.inject({
        method: 'GET',
        url: '/api/defects?overdue=true',
        headers: auth(engineer),
      });

      expect(response.statusCode).toBe(200);
      const defects = response.json().defects;
      expect(defects).toHaveLength(1);
      expect(defects[0].aircraft.registration).toBe('LY-LATE');
    });

    it('drops a defect out of the overdue list once it is closed', async () => {
      const defect = await makeOverdue('LY-FIXED');
      await patch(defect.id, { status: 'CLOSED' });

      const response = await app.inject({ method: 'GET', url: '/api/defects?overdue=true', headers: auth(engineer) });
      expect(response.json().defects).toHaveLength(0);
    });

    it('counts overdue defects on the overview', async () => {
      await makeOverdue('LY-L1');
      await makeOverdue('LY-L2');
      await raise('CAT_C', 'LY-OK');

      const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: auth(engineer) });
      expect(overview.json().overdueDefects).toBe(2);
    });

    it('counts an expired deferral as overdue', async () => {
      const defect = await raise('CAT_C');
      await defer(defect.id, { deferralRef: 'MEL-7', expiresAt: daysFromNow(30).toISOString() });
      // The MEL window runs out.
      await prisma.defect.update({
        where: { id: defect.id },
        data: { dueAt: daysFromNow(-1), deferralExpiresAt: daysFromNow(-1) },
      });

      const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: auth(engineer) });
      expect(overview.json().overdueDefects).toBe(1);
    });

    it('orders the overdue worklist by how late it is', async () => {
      const a = await makeOverdue('LY-A');
      const b = await makeOverdue('LY-B');
      await prisma.defect.update({ where: { id: a.id }, data: { dueAt: daysFromNow(-1) } });
      await prisma.defect.update({ where: { id: b.id }, data: { dueAt: daysFromNow(-20) } });

      const response = await app.inject({ method: 'GET', url: '/api/defects?overdue=true', headers: auth(engineer) });
      const regs = response.json().defects.map((d: { aircraft: { registration: string } }) => d.aircraft.registration);
      expect(regs).toEqual(['LY-B', 'LY-A']);
    });
  });
  describe('deferral cannot be faked', () => {
    it('refuses a status flip straight to DEFERRED', async () => {
      const aircraft = await createAircraft('LY-FAK');
      const defect = await createDefect(aircraft.id, { category: 'CAT_C' });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/defects/${defect.id}`,
        headers: auth(engineer),
        payload: { status: 'DEFERRED' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('/defer');

      const after = await prisma.defect.findUniqueOrThrow({ where: { id: defect.id } });
      expect(after.status).toBe('OPEN');
      expect(after.deferralRef).toBeNull();
      expect(after.deferralExpiresAt).toBeNull();
    });

    it('refuses the flip even for a defect that could legitimately be deferred', async () => {
      const aircraft = await createAircraft('LY-FK2');
      const defect = await createDefect(aircraft.id, { category: 'CAT_B' });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/defects/${defect.id}`,
        headers: auth(engineer),
        payload: { status: 'DEFERRED', category: 'CAT_D' },
      });

      expect(response.statusCode).toBe(400);
      const after = await prisma.defect.findUniqueOrThrow({ where: { id: defect.id } });
      expect(after.status).toBe('OPEN');
      expect(after.category).toBe('CAT_B');
    });

    it('still allows the statuses a defect does move through by hand', async () => {
      const aircraft = await createAircraft('LY-OKS');
      const defect = await createDefect(aircraft.id, { category: 'CAT_C' });

      const closed = await app.inject({
        method: 'PATCH',
        url: `/api/defects/${defect.id}`,
        headers: auth(engineer),
        payload: { status: 'CLOSED' },
      });
      expect(closed.statusCode).toBe(200);

      const reopened = await app.inject({
        method: 'PATCH',
        url: `/api/defects/${defect.id}`,
        headers: auth(engineer),
        payload: { status: 'OPEN' },
      });
      expect(reopened.statusCode).toBe(200);
    });

    it('keeps the MEL expiry as the deadline when a deferred defect is re-categorised', async () => {
      const aircraft = await createAircraft('LY-REC');
      const defect = await createDefect(aircraft.id, { category: 'CAT_C' });
      const expiresAt = new Date(Date.now() + 30 * 86_400_000);

      await app.inject({
        method: 'POST',
        url: `/api/defects/${defect.id}/defer`,
        headers: auth(engineer),
        payload: { deferralRef: 'MEL-36-11-01A', expiresAt: expiresAt.toISOString() },
      });

      // Re-categorising must not quietly swap the agreed expiry for the category window.
      const recategorised = await app.inject({
        method: 'PATCH',
        url: `/api/defects/${defect.id}`,
        headers: auth(engineer),
        payload: { category: 'CAT_A' },
      });
      expect(recategorised.statusCode).toBe(200);

      const after = await prisma.defect.findUniqueOrThrow({ where: { id: defect.id } });
      expect(after.category).toBe('CAT_A');
      expect(after.dueAt?.toISOString()).toBe(expiresAt.toISOString());
    });
  });
});
