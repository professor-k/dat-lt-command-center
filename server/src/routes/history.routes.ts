import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';
import { recordAudit } from '../audit.js';

/**
 * Monthly defect counts. These are the baseline the year-end projection on the
 * overview is built from, so they are reference data an engineer maintains by
 * hand rather than something the defect log derives.
 */
const listQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

const upsertBody = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  count: z.coerce.number().int().min(0).max(100_000),
});

export async function historyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const year = parsed.data.year ?? new Date().getFullYear();
    const months = await prisma.defectHistory.findMany({
      where: { year },
      orderBy: { month: 'asc' },
      select: { month: true, count: true },
    });
    return { year, months, total: months.reduce((sum, m) => sum + m.count, 0) };
  });

  app.put('/', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const parsed = upsertBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const { year, month, count } = parsed.data;
    const entry = await prisma.defectHistory.upsert({
      where: { year_month: { year, month } },
      create: { year, month, count },
      update: { count },
    });

    broadcast({ type: 'history.updated', payload: { year, month, count } });
    await recordAudit(request, {
      action: 'history.updated',
      entityType: 'DefectHistory',
      entityId: entry.id,
      summary: `Defect baseline ${year}-${String(month).padStart(2, '0')} set to ${count}`,
      after: { year, month, count },
    });
    return { entry };
  });

  app.delete('/:year/:month', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const params = z
      .object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) })
      .safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'BadRequest', issues: params.error.issues });

    const { year, month } = params.data;
    const existing = await prisma.defectHistory.findUnique({ where: { year_month: { year, month } } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'No entry for that month' });

    await prisma.defectHistory.delete({ where: { id: existing.id } });
    broadcast({ type: 'history.updated', payload: { year, month, count: null } });
    await recordAudit(request, {
      action: 'history.cleared',
      entityType: 'DefectHistory',
      entityId: existing.id,
      summary: `Defect baseline ${year}-${String(month).padStart(2, '0')} cleared`,
      before: { year, month, count: existing.count },
    });
    return reply.code(204).send();
  });
}
