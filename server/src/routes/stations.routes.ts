import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';
import { changedFields, recordAudit } from '../audit.js';

const createStation = z.object({
  code: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/, 'Station code must be a 3-letter IATA code'),
  city: z.string().trim().min(2).max(60),
  country: z.string().trim().min(2).max(60).default('Italy'),
  networkStatus: z.enum(['OPTIMAL', 'DEGRADED', 'CRITICAL']).default('OPTIMAL'),
  complianceStatus: z.enum(['PASSED', 'PASSED_MINOR', 'PENDING_REVIEW', 'FAILED']).default('PASSED'),
  lastAuditAt: z.coerce.date().optional(),
  requiredAction: z.string().trim().min(2).nullable().optional(),
});

const patchStation = z.object({
  networkStatus: z.enum(['OPTIMAL', 'DEGRADED', 'CRITICAL']).optional(),
  complianceStatus: z.enum(['PASSED', 'PASSED_MINOR', 'PENDING_REVIEW', 'FAILED']).optional(),
  requiredAction: z.string().nullable().optional(),
  lastAuditAt: z.coerce.date().optional(),
});

const createImpediment = z.object({
  category: z.string().min(2),
  description: z.string().min(3),
});

const patchImpediment = z.object({
  status: z.enum(['OPEN', 'MITIGATED', 'RESOLVED']),
});

export async function stationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async () => {
    const stations = await prisma.station.findMany({
      include: {
        impediments: { where: { status: { not: 'RESOLVED' } }, orderBy: { openedAt: 'desc' } },
        aircraft: { select: { registration: true, operationalStatus: true } },
      },
      orderBy: { code: 'asc' },
    });
    return { stations };
  });

  app.get('/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const station = await prisma.station.findUnique({
      where: { code: code.toUpperCase() },
      include: {
        impediments: { orderBy: { openedAt: 'desc' } },
        aircraft: { select: { registration: true, model: true, operationalStatus: true } },
      },
    });
    if (!station) return reply.code(404).send({ error: 'NotFound', message: 'Station not found' });
    return { station };
  });

  app.post('/', { preHandler: requireRole('ADMIN') }, async (request, reply) => {
    const parsed = createStation.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const code = parsed.data.code.toUpperCase();
    const exists = await prisma.station.findUnique({ where: { code } });
    if (exists) return reply.code(409).send({ error: 'Conflict', message: `Station ${code} already exists` });

    const station = await prisma.station.create({
      data: { ...parsed.data, code },
      include: { impediments: true, aircraft: { select: { registration: true, operationalStatus: true } } },
    });
    broadcast({ type: 'station.created', payload: { code: station.code, networkStatus: station.networkStatus } });
    await recordAudit(request, {
      action: 'station.created',
      entityType: 'Station',
      entityId: station.id,
      summary: `${station.code} (${station.city}) opened`,
      after: { code: station.code, city: station.city, networkStatus: station.networkStatus },
    });
    return reply.code(201).send({ station });
  });

  app.patch('/:code', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const parsed = patchStation.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const existing = await prisma.station.findUnique({ where: { code: code.toUpperCase() } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Station not found' });

    const station = await prisma.station.update({
      where: { id: existing.id },
      data: parsed.data,
      include: { impediments: { where: { status: { not: 'RESOLVED' } } } },
    });
    broadcast({ type: 'station.updated', payload: { code: station.code, networkStatus: station.networkStatus } });
    await recordAudit(request, {
      action: 'station.updated',
      entityType: 'Station',
      entityId: station.id,
      summary: `${station.code}: ${existing.networkStatus !== station.networkStatus ? `network ${existing.networkStatus} → ${station.networkStatus}` : 'record updated'}`,
      ...changedFields(
        { networkStatus: existing.networkStatus, complianceStatus: existing.complianceStatus, requiredAction: existing.requiredAction },
        { networkStatus: station.networkStatus, complianceStatus: station.complianceStatus, requiredAction: station.requiredAction },
        ['networkStatus', 'complianceStatus', 'requiredAction'],
      ),
    });
    return { station };
  });

  /**
   * Closes a station down. Impediments cascade with it, but aircraft would be
   * silently unassigned, so a station still holding airframes is refused.
   */
  app.delete('/:code', { preHandler: requireRole('ADMIN') }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const existing = await prisma.station.findUnique({
      where: { code: code.toUpperCase() },
      include: { _count: { select: { aircraft: true } } },
    });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Station not found' });

    if (existing._count.aircraft > 0) {
      return reply.code(409).send({
        error: 'Conflict',
        message: `${existing.code} still hosts ${existing._count.aircraft} aircraft; move them to another station first`,
      });
    }

    await prisma.station.delete({ where: { id: existing.id } });
    broadcast({ type: 'station.deleted', payload: { code: existing.code } });
    await recordAudit(request, {
      action: 'station.closed',
      entityType: 'Station',
      entityId: existing.id,
      summary: `${existing.code} (${existing.city}) closed`,
      before: { code: existing.code, city: existing.city, networkStatus: existing.networkStatus },
    });
    return reply.code(204).send();
  });

  app.post('/:code/impediments', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const parsed = createImpediment.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const station = await prisma.station.findUnique({ where: { code: code.toUpperCase() } });
    if (!station) return reply.code(404).send({ error: 'NotFound', message: 'Station not found' });

    const impediment = await prisma.impediment.create({
      data: { ...parsed.data, stationId: station.id },
    });
    broadcast({ type: 'impediment.updated', payload: { stationCode: station.code, id: impediment.id } });
    await recordAudit(request, {
      action: 'impediment.opened',
      entityType: 'Impediment',
      entityId: impediment.id,
      summary: `${station.code}: ${impediment.category} impediment opened — ${impediment.description}`,
      after: { station: station.code, category: impediment.category, description: impediment.description, status: impediment.status },
    });
    return reply.code(201).send({ impediment });
  });

  app.patch('/impediments/:id', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchImpediment.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const existing = await prisma.impediment.findUnique({ where: { id }, include: { station: true } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Impediment not found' });

    const impediment = await prisma.impediment.update({
      where: { id },
      data: {
        status: parsed.data.status,
        resolvedAt: parsed.data.status === 'RESOLVED' ? new Date() : null,
      },
    });
    broadcast({ type: 'impediment.updated', payload: { stationCode: existing.station.code, id } });
    await recordAudit(request, {
      action: impediment.status === 'RESOLVED' ? 'impediment.resolved' : 'impediment.updated',
      entityType: 'Impediment',
      entityId: impediment.id,
      summary: `${existing.station.code}: ${existing.category} impediment ${existing.status} → ${impediment.status}`,
      ...changedFields(
        { status: existing.status, resolvedAt: existing.resolvedAt },
        { status: impediment.status, resolvedAt: impediment.resolvedAt },
        ['status', 'resolvedAt'],
      ),
    });
    return { impediment };
  });
}
