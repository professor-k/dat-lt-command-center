import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';
import { changedFields, recordAudit } from '../audit.js';

/** Registrations are stored upper-case: letters, digits and hyphens (LY-DAT). */
const registrationField = z
  .string()
  .trim()
  .min(3)
  .max(10)
  .regex(/^[A-Za-z0-9-]+$/, 'Registration may contain letters, digits and hyphens only');

const createAircraft = z.object({
  registration: registrationField,
  model: z.string().trim().min(2).max(40).default('ATR 72-600'),
  operationalStatus: z.enum(['ACTIVE', 'AOG', 'MAINTENANCE', 'STORED']).default('ACTIVE'),
  stationCode: z.string().length(3).optional(),
  flightHours: z.number().nonnegative().default(0),
  cycles: z.number().int().nonnegative().default(0),
});

const patchAircraft = z.object({
  operationalStatus: z.enum(['ACTIVE', 'AOG', 'MAINTENANCE', 'STORED']).optional(),
  // null unassigns the airframe from the network.
  stationCode: z.string().length(3).nullable().optional(),
  flightHours: z.number().nonnegative().optional(),
  cycles: z.number().int().nonnegative().optional(),
});

/** Shapes an aircraft row the way the telemetry table needs it. */
function toTelemetryRow(a: any) {
  const openDefects = a.defects.filter((d: any) => d.status !== 'CLOSED');
  const worst = openDefects.some((d: any) => d.category === 'CRITICAL')
    ? 'CRITICAL'
    : openDefects[0]?.category ?? null;
  const alert = a.alerts[0] ?? null;

  return {
    id: a.id,
    registration: a.registration,
    model: a.model,
    operationalStatus: a.operationalStatus,
    flightHours: a.flightHours,
    cycles: a.cycles,
    station: a.station ? { code: a.station.code, city: a.station.city } : null,
    openDefectCount: openDefects.length,
    worstDefectCategory: worst,
    predictiveAlert: alert
      ? {
          id: alert.id,
          component: alert.component,
          ataChapter: alert.ataChapter,
          severity: alert.severity,
          dueInDays: alert.dueInDays,
          recommendation: alert.recommendation,
        }
      : null,
  };
}

const include = {
  station: true,
  defects: { where: { status: { not: 'CLOSED' as const } }, orderBy: { raisedAt: 'desc' as const } },
  alerts: {
    where: { acknowledged: false },
    orderBy: [{ severity: 'desc' as const }, { dueInDays: 'asc' as const }],
  },
};

export async function fleetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async () => {
    const aircraft = await prisma.aircraft.findMany({ include, orderBy: { registration: 'asc' } });
    return { aircraft: aircraft.map(toTelemetryRow) };
  });

  app.get('/:registration', async (request, reply) => {
    const { registration } = request.params as { registration: string };
    const aircraft = await prisma.aircraft.findUnique({
      where: { registration: registration.toUpperCase() },
      include: {
        station: true,
        defects: { orderBy: { raisedAt: 'desc' }, include: { deferredBy: { select: { name: true } } } },
        alerts: { orderBy: [{ severity: 'desc' }, { dueInDays: 'asc' }] },
      },
    });
    if (!aircraft) return reply.code(404).send({ error: 'NotFound', message: 'Aircraft not found' });
    return { aircraft };
  });

  app.post('/', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const parsed = createAircraft.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const { registration, stationCode, ...rest } = parsed.data;
    const reg = registration.toUpperCase();

    const exists = await prisma.aircraft.findUnique({ where: { registration: reg } });
    if (exists) return reply.code(409).send({ error: 'Conflict', message: `${reg} is already on the fleet` });

    let stationId: string | undefined;
    if (stationCode) {
      const station = await prisma.station.findUnique({ where: { code: stationCode.toUpperCase() } });
      if (!station) return reply.code(400).send({ error: 'BadRequest', message: 'Unknown station code' });
      stationId = station.id;
    }

    const aircraft = await prisma.aircraft.create({
      data: { ...rest, registration: reg, ...(stationId ? { stationId } : {}) },
      include,
    });

    const row = toTelemetryRow(aircraft);
    broadcast({ type: 'aircraft.created', payload: row });
    await recordAudit(request, {
      action: 'aircraft.created',
      entityType: 'Aircraft',
      entityId: aircraft.id,
      summary: `${reg} added to the fleet${aircraft.station ? ` at ${aircraft.station.code}` : ''}`,
      after: { registration: reg, operationalStatus: aircraft.operationalStatus, station: aircraft.station?.code ?? null },
    });
    return reply.code(201).send({ aircraft: row });
  });

  app.patch(
    '/:registration',
    { preHandler: requireRole('ADMIN', 'ENGINEER') },
    async (request, reply) => {
      const { registration } = request.params as { registration: string };
      const parsed = patchAircraft.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

      const { stationCode, ...rest } = parsed.data;
      let stationId: string | null | undefined;
      if (stationCode === null) {
        stationId = null;
      } else if (stationCode) {
        const station = await prisma.station.findUnique({ where: { code: stationCode.toUpperCase() } });
        if (!station) return reply.code(400).send({ error: 'BadRequest', message: 'Unknown station code' });
        stationId = station.id;
      }

      const existing = await prisma.aircraft.findUnique({
        where: { registration: registration.toUpperCase() },
        include: { station: { select: { code: true } } },
      });
      if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Aircraft not found' });

      const aircraft = await prisma.aircraft.update({
        where: { id: existing.id },
        data: { ...rest, ...(stationId !== undefined ? { stationId } : {}) },
        include,
      });

      const row = toTelemetryRow(aircraft);
      broadcast({ type: 'aircraft.updated', payload: row });

      const movedStation = (existing.station?.code ?? null) !== (aircraft.station?.code ?? null);
      const changedStatus = existing.operationalStatus !== aircraft.operationalStatus;
      const parts = [
        changedStatus ? `status ${existing.operationalStatus} → ${aircraft.operationalStatus}` : null,
        movedStation ? `moved ${existing.station?.code ?? 'unassigned'} → ${aircraft.station?.code ?? 'unassigned'}` : null,
      ].filter(Boolean);

      await recordAudit(request, {
        action: movedStation && !changedStatus ? 'aircraft.moved' : 'aircraft.updated',
        entityType: 'Aircraft',
        entityId: aircraft.id,
        summary: `${aircraft.registration}: ${parts.length ? parts.join(', ') : 'record updated'}`,
        ...changedFields(
          { status: existing.operationalStatus, station: existing.station?.code ?? null, flightHours: existing.flightHours, cycles: existing.cycles },
          { status: aircraft.operationalStatus, station: aircraft.station?.code ?? null, flightHours: aircraft.flightHours, cycles: aircraft.cycles },
          ['status', 'station', 'flightHours', 'cycles'],
        ),
      });
      return { aircraft: row };
    },
  );

  /**
   * Removes an airframe from the fleet. Defects cascade, so an aircraft carrying
   * any technical record is refused: the maintenance log must outlive the UI.
   * Retiring a real airframe is a status change to STORED, not a deletion.
   */
  app.delete('/:registration', { preHandler: requireRole('ADMIN') }, async (request, reply) => {
    const { registration } = request.params as { registration: string };
    const existing = await prisma.aircraft.findUnique({
      where: { registration: registration.toUpperCase() },
      include: { _count: { select: { defects: true } } },
    });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Aircraft not found' });

    if (existing._count.defects > 0) {
      return reply.code(409).send({
        error: 'Conflict',
        message: `${existing.registration} holds ${existing._count.defects} technical record(s); set it STORED instead of deleting it`,
      });
    }

    await prisma.aircraft.delete({ where: { id: existing.id } });
    broadcast({ type: 'aircraft.deleted', payload: { registration: existing.registration } });
    await recordAudit(request, {
      action: 'aircraft.deleted',
      entityType: 'Aircraft',
      entityId: existing.id,
      summary: `${existing.registration} removed from the fleet`,
      before: { registration: existing.registration, operationalStatus: existing.operationalStatus },
    });
    return reply.code(204).send();
  });
}
