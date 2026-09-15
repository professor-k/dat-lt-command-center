import type { FastifyInstance } from 'fastify';
import type { DefectCategory } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';

const listQuery = z.object({
  status: z.enum(['OPEN', 'DEFERRED', 'CLOSED']).optional(),
  registration: z.string().optional(),
  ataChapter: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).default(100),
});

const createBody = z.object({
  registration: z.string().min(3),
  ataChapter: z.string().min(1).max(4),
  title: z.string().min(3),
  description: z.string().optional(),
  category: z.enum(['CRITICAL', 'CAT_A', 'CAT_B', 'CAT_C', 'CAT_D']).default('CAT_C'),
  repetitive: z.boolean().default(false),
  dueAt: z.coerce.date().optional(),
});

const patchBody = z.object({
  status: z.enum(['OPEN', 'DEFERRED', 'CLOSED']).optional(),
  category: z.enum(['CRITICAL', 'CAT_A', 'CAT_B', 'CAT_C', 'CAT_D']).optional(),
  description: z.string().optional(),
  repetitive: z.boolean().optional(),
});

/** MEL-style rectification windows, in days, by defect category. */
const DUE_DAYS: Record<DefectCategory, number | null> = {
  CRITICAL: 0,
  CAT_A: 1,
  CAT_B: 3,
  CAT_C: 10,
  CAT_D: 120,
};

/**
 * The rectification deadline a category implies, measured from `from`. A category with
 * no window (none today) carries no deadline.
 */
export function dueDateFor(category: DefectCategory, from: Date = new Date()): Date | null {
  const windowDays = DUE_DAYS[category];
  return windowDays === null ? null : new Date(from.getTime() + windowDays * 86_400_000);
}

async function nextReference() {
  const year = new Date().getFullYear();
  const count = await prisma.defect.count({ where: { reference: { startsWith: `DEF-${year}-` } } });
  return `DEF-${year}-${String(count + 1).padStart(4, '0')}`;
}

export async function defectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });
    const { status, registration, ataChapter, take } = parsed.data;

    const defects = await prisma.defect.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(ataChapter ? { ataChapter } : {}),
        ...(registration ? { aircraft: { registration: registration.toUpperCase() } } : {}),
      },
      include: {
        aircraft: { select: { registration: true, model: true, station: { select: { code: true } } } },
        raisedBy: { select: { name: true } },
        closedBy: { select: { name: true } },
      },
      orderBy: [{ status: 'asc' }, { raisedAt: 'desc' }],
      take,
    });
    return { defects };
  });

  app.post('/', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });
    const { registration, dueAt, ...rest } = parsed.data;

    const aircraft = await prisma.aircraft.findUnique({ where: { registration: registration.toUpperCase() } });
    if (!aircraft) return reply.code(400).send({ error: 'BadRequest', message: 'Unknown aircraft registration' });

    const computedDue = dueAt ?? dueDateFor(rest.category);

    const defect = await prisma.defect.create({
      data: {
        ...rest,
        reference: await nextReference(),
        aircraftId: aircraft.id,
        dueAt: computedDue,
        raisedById: request.user.sub,
      },
      include: { aircraft: { select: { registration: true } } },
    });

    // A no-go defect grounds the aircraft immediately.
    if (defect.category === 'CRITICAL' && aircraft.operationalStatus === 'ACTIVE') {
      await prisma.aircraft.update({ where: { id: aircraft.id }, data: { operationalStatus: 'AOG' } });
    }

    broadcast({ type: 'defect.created', payload: { id: defect.id, registration: defect.aircraft.registration } });
    return reply.code(201).send({ defect });
  });

  app.patch('/:id', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const existing = await prisma.defect.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Defect not found' });

    const closing = parsed.data.status === 'CLOSED' && existing.status !== 'CLOSED';
    const defect = await prisma.defect.update({
      where: { id },
      data: {
        ...parsed.data,
        ...(closing ? { closedAt: new Date(), closedById: request.user.sub } : {}),
        ...(parsed.data.status && parsed.data.status !== 'CLOSED' ? { closedAt: null, closedById: null } : {}),
      },
      include: { aircraft: { select: { id: true, registration: true, operationalStatus: true } } },
    });

    // Clearing the last critical defect releases the aircraft back to service.
    if (closing) {
      const blocking = await prisma.defect.count({
        where: { aircraftId: defect.aircraftId, status: { not: 'CLOSED' }, category: 'CRITICAL' },
      });
      if (blocking === 0 && defect.aircraft.operationalStatus === 'AOG') {
        await prisma.aircraft.update({ where: { id: defect.aircraftId }, data: { operationalStatus: 'ACTIVE' } });
      }
    }

    broadcast({ type: 'defect.updated', payload: { id: defect.id, status: defect.status } });
    return { defect };
  });
}
