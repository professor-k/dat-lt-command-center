import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';

/**
 * The audit trail is the one collection that grows without bound, so unlike every other
 * list in this API it is paged with a cursor rather than returned whole.
 */
const listQuery = z.object({
  entityType: z.enum(['Aircraft', 'Station', 'Impediment', 'PredictiveAlert', 'Defect', 'DefectHistory', 'User']).optional(),
  entityId: z.string().optional(),
  actorId: z.string().optional(),
  action: z.string().optional(),
  since: z.coerce.date().optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: requireRole('ADMIN') }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const { entityType, entityId, actorId, action, since, take, cursor } = parsed.data;

    // One extra row tells us whether another page exists without a second count query.
    const rows = await prisma.auditLog.findMany({
      where: {
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
        ...(actorId ? { actorId } : {}),
        ...(action ? { action: { startsWith: action } } : {}),
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const entries = rows.slice(0, take);
    return {
      entries,
      nextCursor: rows.length > take ? entries[entries.length - 1].id : null,
    };
  });
}
