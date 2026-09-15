import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';

const createAlert = z.object({
  registration: z.string().trim().min(3),
  component: z.string().trim().min(2).max(60),
  ataChapter: z.string().trim().min(1).max(4),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('INFO'),
  // 0 = act now; the horizon the reliability engineer is working to.
  dueInDays: z.number().int().min(0).max(3650),
  confidence: z.number().min(0).max(1).default(0.8),
  recommendation: z.string().trim().min(3).max(240),
});

const patchAlert = z.object({ acknowledged: z.boolean() });

export async function alertRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request) => {
    const { acknowledged } = request.query as { acknowledged?: string };
    const alerts = await prisma.predictiveAlert.findMany({
      where: acknowledged === undefined ? {} : { acknowledged: acknowledged === 'true' },
      include: { aircraft: { select: { registration: true, model: true } } },
      orderBy: [{ severity: 'desc' }, { dueInDays: 'asc' }],
    });
    return { alerts };
  });

  app.post('/', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const parsed = createAlert.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const { registration, ...rest } = parsed.data;
    const aircraft = await prisma.aircraft.findUnique({ where: { registration: registration.toUpperCase() } });
    if (!aircraft) return reply.code(400).send({ error: 'BadRequest', message: 'Unknown aircraft registration' });

    const alert = await prisma.predictiveAlert.create({
      data: { ...rest, aircraftId: aircraft.id },
      include: { aircraft: { select: { registration: true, model: true } } },
    });

    broadcast({ type: 'alert.created', payload: { id: alert.id, registration: alert.aircraft.registration } });
    return reply.code(201).send({ alert });
  });

  app.patch('/:id', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchAlert.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const existing = await prisma.predictiveAlert.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Alert not found' });

    const alert = await prisma.predictiveAlert.update({ where: { id }, data: parsed.data });
    broadcast({ type: 'alert.updated', payload: { id: alert.id, acknowledged: alert.acknowledged } });
    return { alert };
  });

  /** Predictions are working estimates, not technical records, so they may be withdrawn outright. */
  app.delete('/:id', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.predictiveAlert.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Alert not found' });

    await prisma.predictiveAlert.delete({ where: { id } });
    broadcast({ type: 'alert.deleted', payload: { id } });
    return reply.code(204).send();
  });
}
