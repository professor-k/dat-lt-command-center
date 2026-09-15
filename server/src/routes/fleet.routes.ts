import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';

const patchAircraft = z.object({
  operationalStatus: z.enum(['ACTIVE', 'AOG', 'MAINTENANCE', 'STORED']).optional(),
  stationCode: z.string().length(3).optional(),
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
        defects: { orderBy: { raisedAt: 'desc' } },
        alerts: { orderBy: [{ severity: 'desc' }, { dueInDays: 'asc' }] },
      },
    });
    if (!aircraft) return reply.code(404).send({ error: 'NotFound', message: 'Aircraft not found' });
    return { aircraft };
  });

  app.patch(
    '/:registration',
    { preHandler: requireRole('ADMIN', 'ENGINEER') },
    async (request, reply) => {
      const { registration } = request.params as { registration: string };
      const parsed = patchAircraft.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

      const { stationCode, ...rest } = parsed.data;
      let stationId: string | undefined;
      if (stationCode) {
        const station = await prisma.station.findUnique({ where: { code: stationCode.toUpperCase() } });
        if (!station) return reply.code(400).send({ error: 'BadRequest', message: 'Unknown station code' });
        stationId = station.id;
      }

      const existing = await prisma.aircraft.findUnique({ where: { registration: registration.toUpperCase() } });
      if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Aircraft not found' });

      const aircraft = await prisma.aircraft.update({
        where: { id: existing.id },
        data: { ...rest, ...(stationId ? { stationId } : {}) },
        include,
      });

      const row = toTelemetryRow(aircraft);
      broadcast({ type: 'aircraft.updated', payload: row });
      return { aircraft: row };
    },
  );
}
