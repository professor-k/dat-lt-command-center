import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createAircraft, createDefect, testApp, tokenFor } from '../helpers/fixtures.js';

/**
 * The rule the whole board is built on: a no-go defect grounds the aircraft, and clearing
 * the last one releases it. Nothing else in the app writes operationalStatus implicitly.
 */
describe('AOG grounding', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await testApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    token = await tokenFor(app, 'ENGINEER');
  });

  const raise = (registration: string, category: string) =>
    app.inject({
      method: 'POST',
      url: '/api/defects',
      headers: auth(token),
      payload: { registration, ataChapter: '36', title: 'Bleed air valve', category },
    });

  it('grounds an active aircraft when a CRITICAL defect is raised', async () => {
    const aircraft = await createAircraft('LY-AOG');

    const response = await raise('LY-AOG', 'CRITICAL');
    expect(response.statusCode).toBe(201);

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('AOG');
  });

  it('leaves the aircraft active for a deferrable defect', async () => {
    const aircraft = await createAircraft('LY-CAT');

    expect((await raise('LY-CAT', 'CAT_C')).statusCode).toBe(201);

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('ACTIVE');
  });

  it('releases the aircraft when the last CRITICAL defect is closed', async () => {
    const aircraft = await createAircraft('LY-REL');
    const raised = await raise('LY-REL', 'CRITICAL');
    const defectId = raised.json().defect.id;

    const closed = await app.inject({
      method: 'PATCH',
      url: `/api/defects/${defectId}`,
      headers: auth(token),
      payload: { status: 'CLOSED' },
    });
    expect(closed.statusCode).toBe(200);

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('ACTIVE');
  });

  it('keeps the aircraft grounded while another CRITICAL defect is still open', async () => {
    const aircraft = await createAircraft('LY-TWO');
    const first = await raise('LY-TWO', 'CRITICAL');
    await raise('LY-TWO', 'CRITICAL');

    await app.inject({
      method: 'PATCH',
      url: `/api/defects/${first.json().defect.id}`,
      headers: auth(token),
      payload: { status: 'CLOSED' },
    });

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('AOG');
  });

  it('does not resurrect an aircraft that was grounded for maintenance', async () => {
    const aircraft = await createAircraft('LY-MNT', { operationalStatus: 'MAINTENANCE' });
    const defect = await createDefect(aircraft.id, { category: 'CRITICAL' });

    await app.inject({
      method: 'PATCH',
      url: `/api/defects/${defect.id}`,
      headers: auth(token),
      payload: { status: 'CLOSED' },
    });

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('MAINTENANCE');
  });
  it('releases the aircraft when the last CRITICAL defect is downgraded', async () => {
    const aircraft = await createAircraft('LY-DWN');
    const raised = await raise('LY-DWN', 'CRITICAL');
    expect((await prisma.aircraft.findUnique({ where: { id: aircraft.id } }))?.operationalStatus).toBe('AOG');

    // The documented first step before deferring a no-go defect: downgrade it. That clears
    // the reason for the AOG just as closing it would.
    const downgraded = await app.inject({
      method: 'PATCH',
      url: `/api/defects/${raised.json().defect.id}`,
      headers: auth(token),
      payload: { category: 'CAT_C' },
    });
    expect(downgraded.statusCode).toBe(200);

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('ACTIVE');
  });

  it('keeps the aircraft grounded when one of two CRITICAL defects is downgraded', async () => {
    const aircraft = await createAircraft('LY-DW2');
    const first = await raise('LY-DW2', 'CRITICAL');
    await raise('LY-DW2', 'CRITICAL');

    await app.inject({
      method: 'PATCH',
      url: `/api/defects/${first.json().defect.id}`,
      headers: auth(token),
      payload: { category: 'CAT_B' },
    });

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('AOG');
  });

  it('grounds the aircraft when a defect is re-categorised up to CRITICAL', async () => {
    const aircraft = await createAircraft('LY-UPG');
    const raised = await raise('LY-UPG', 'CAT_C');
    expect((await prisma.aircraft.findUnique({ where: { id: aircraft.id } }))?.operationalStatus).toBe('ACTIVE');

    const upgraded = await app.inject({
      method: 'PATCH',
      url: `/api/defects/${raised.json().defect.id}`,
      headers: auth(token),
      payload: { category: 'CRITICAL' },
    });
    expect(upgraded.statusCode).toBe(200);

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('AOG');
  });

  it('does not release an aircraft that is in maintenance when a defect is downgraded', async () => {
    const aircraft = await createAircraft('LY-MN2', { operationalStatus: 'MAINTENANCE' });
    const defect = await createDefect(aircraft.id, { category: 'CRITICAL' });

    await app.inject({
      method: 'PATCH',
      url: `/api/defects/${defect.id}`,
      headers: auth(token),
      payload: { category: 'CAT_C' },
    });

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('MAINTENANCE');
  });

  it('leaves an aircraft grounded by hand alone when an unrelated defect is closed', async () => {
    const aircraft = await createAircraft('LY-HND', { operationalStatus: 'AOG' });
    const defect = await createDefect(aircraft.id, { category: 'CAT_C' });

    await app.inject({
      method: 'PATCH',
      url: `/api/defects/${defect.id}`,
      headers: auth(token),
      payload: { status: 'CLOSED' },
    });

    const after = await prisma.aircraft.findUnique({ where: { id: aircraft.id } });
    expect(after?.operationalStatus).toBe('AOG');
  });

  it('notes the release in the audit trail', async () => {
    await createAircraft('LY-AUD');
    const raised = await raise('LY-AUD', 'CRITICAL');

    await app.inject({
      method: 'PATCH',
      url: `/api/defects/${raised.json().defect.id}`,
      headers: auth(token),
      payload: { category: 'CAT_C' },
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Defect', action: 'defect.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry.summary).toContain('aircraft released to service');
  });
});
