import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';

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
    return { station };
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
    return { impediment };
  });
}
