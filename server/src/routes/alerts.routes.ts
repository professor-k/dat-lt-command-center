import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';

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
}
