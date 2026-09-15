import type { FastifyInstance } from 'fastify';
import type { DefectCategory } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';
import { recordAudit } from '../audit.js';

const listQuery = z.object({
  status: z.enum(['OPEN', 'DEFERRED', 'CLOSED']).optional(),
  registration: z.string().optional(),
  ataChapter: z.string().optional(),
  // Anything still open whose rectification window has already run out.
  overdue: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
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

/**
 * Still on the aircraft, and past the date it should have been cleared by. Built per call:
 * a module-level constant would freeze "now" at the moment the server started.
 */
export const overdueWhere = () => ({
  status: { not: 'CLOSED' as const },
  dueAt: { lt: new Date() },
});

const deferBody = z.object({
  deferralRef: z.string().trim().min(2).max(40),
  expiresAt: z.coerce.date(),
  note: z.string().trim().max(400).optional(),
});

/**
 * An aircraft is held AOG for exactly as long as a no-go defect is open against it. Both
 * directions are guarded on the status they expect, so they are idempotent, safe to call
 * on every change, and never touch an airframe that is MAINTENANCE or STORED — those are
 * someone's deliberate decision, not a consequence of the defect log.
 */
async function groundIfCritical(aircraftId: string): Promise<boolean> {
  const { count } = await prisma.aircraft.updateMany({
    where: { id: aircraftId, operationalStatus: 'ACTIVE' },
    data: { operationalStatus: 'AOG' },
  });
  return count > 0;
}

async function releaseIfNoLongerGrounded(aircraftId: string): Promise<boolean> {
  const blocking = await prisma.defect.count({
    where: { aircraftId, status: { not: 'CLOSED' }, category: 'CRITICAL' },
  });
  if (blocking > 0) return false;

  const { count } = await prisma.aircraft.updateMany({
    where: { id: aircraftId, operationalStatus: 'AOG' },
    data: { operationalStatus: 'ACTIVE' },
  });
  return count > 0;
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
    const { status, registration, ataChapter, overdue, take } = parsed.data;

    const defects = await prisma.defect.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(ataChapter ? { ataChapter } : {}),
        ...(registration ? { aircraft: { registration: registration.toUpperCase() } } : {}),
        ...(overdue ? overdueWhere() : {}),
      },
      include: {
        aircraft: { select: { registration: true, model: true, station: { select: { code: true } } } },
        raisedBy: { select: { name: true } },
        closedBy: { select: { name: true } },
        deferredBy: { select: { name: true } },
      },
      // Overdue is a worklist: the latest first. Otherwise the log reads newest-first.
      orderBy: overdue ? [{ dueAt: 'asc' }] : [{ status: 'asc' }, { raisedAt: 'desc' }],
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
    const grounded = defect.category === 'CRITICAL' && (await groundIfCritical(aircraft.id));

    broadcast({ type: 'defect.created', payload: { id: defect.id, registration: defect.aircraft.registration } });
    await recordAudit(request, {
      action: 'defect.created',
      entityType: 'Defect',
      entityId: defect.id,
      summary:
        `${defect.reference} raised on ${defect.aircraft.registration}: ${defect.title} (${defect.category})` +
        (grounded ? ' — aircraft grounded' : ''),
      after: { reference: defect.reference, category: defect.category, ataChapter: defect.ataChapter },
    });
    return reply.code(201).send({ defect });
  });

  app.patch('/:id', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const existing = await prisma.defect.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Defect not found' });

    const closing = parsed.data.status === 'CLOSED' && existing.status !== 'CLOSED';

    // Re-categorising changes the rectification window, so the deadline has to move with
    // it — otherwise a CAT_D downgraded to CAT_A keeps its 120-day date. A defect carried
    // forward under the MEL keeps the expiry on its deferral instead.
    const recategorised = parsed.data.category !== undefined && parsed.data.category !== existing.category;
    const deferred = (parsed.data.status ?? existing.status) === 'DEFERRED';
    const newDueAt = recategorised && !deferred ? { dueAt: dueDateFor(parsed.data.category!) } : {};

    // Bringing a deferred defect back to OPEN drops the deferral with it.
    const undeferring = existing.status === 'DEFERRED' && parsed.data.status === 'OPEN';
    const clearedDeferral = undeferring
      ? {
          deferralRef: null,
          deferralNote: null,
          deferredAt: null,
          deferralExpiresAt: null,
          deferredById: null,
          dueAt: dueDateFor(parsed.data.category ?? existing.category),
        }
      : {};

    const defect = await prisma.defect.update({
      where: { id },
      data: {
        ...parsed.data,
        ...newDueAt,
        ...clearedDeferral,
        ...(closing ? { closedAt: new Date(), closedById: request.user.sub } : {}),
        ...(parsed.data.status && parsed.data.status !== 'CLOSED' ? { closedAt: null, closedById: null } : {}),
      },
      include: { aircraft: { select: { id: true, registration: true, operationalStatus: true } } },
    });

    // Whether an aircraft is grounded follows from the defects open against it, so it is
    // reconciled after any change that can alter that — not only on close. Downgrading the
    // last CRITICAL defect clears the reason for the AOG just as closing it does, and that
    // is the documented first step before deferring one.
    // Only this defect's own no-go status is acted on. An airframe set AOG by hand from the
    // fleet board is somebody's decision about that aircraft, and editing an unrelated
    // defect is no reason to overturn it.
    const wasNoGo = existing.category === 'CRITICAL' && existing.status !== 'CLOSED';
    const isNoGo = defect.category === 'CRITICAL' && defect.status !== 'CLOSED';
    const grounded = !wasNoGo && isNoGo && (await groundIfCritical(defect.aircraftId));
    const released = wasNoGo && !isNoGo && (await releaseIfNoLongerGrounded(defect.aircraftId));

    broadcast({ type: 'defect.updated', payload: { id: defect.id, status: defect.status } });

    const changes = [
      existing.status !== defect.status ? `${existing.status} → ${defect.status}` : null,
      recategorised ? `category ${existing.category} → ${defect.category}` : null,
      undeferring ? 'deferral withdrawn' : null,
      grounded ? 'aircraft grounded' : null,
      released ? 'aircraft released to service' : null,
    ].filter(Boolean);

    await recordAudit(request, {
      action: closing ? 'defect.closed' : 'defect.updated',
      entityType: 'Defect',
      entityId: defect.id,
      summary: `${defect.reference} (${defect.aircraft.registration}): ${changes.length ? changes.join(', ') : 'record updated'}`,
      before: { status: existing.status, category: existing.category, dueAt: existing.dueAt?.toISOString() ?? null },
      after: { status: defect.status, category: defect.category, dueAt: defect.dueAt?.toISOString() ?? null },
    });
    return { defect };
  });

  /**
   * Carries a defect forward under the MEL against a reference, an approving engineer and
   * an expiry, which becomes the new deadline. A CRITICAL defect is no-go by definition and
   * cannot be deferred — that is the rule the AOG grounding exists to enforce.
   */
  app.post('/:id/defer', { preHandler: requireRole('ADMIN', 'ENGINEER') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = deferBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const existing = await prisma.defect.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'Defect not found' });

    if (existing.status === 'CLOSED') {
      return reply.code(409).send({ error: 'Conflict', message: 'This defect is already closed' });
    }
    if (existing.category === 'CRITICAL') {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'A CRITICAL defect is no-go and cannot be deferred; downgrade the category first',
      });
    }

    const { deferralRef, expiresAt, note } = parsed.data;
    if (expiresAt.getTime() <= Date.now()) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Deferral expiry must be in the future' });
    }

    const defect = await prisma.defect.update({
      where: { id },
      data: {
        status: 'DEFERRED',
        deferralRef,
        deferralNote: note ?? null,
        deferralExpiresAt: expiresAt,
        deferredAt: new Date(),
        deferredById: request.user.sub,
        // The MEL expiry is the deadline now; it replaces the category window.
        dueAt: expiresAt,
        closedAt: null,
        closedById: null,
      },
      include: { aircraft: { select: { registration: true } }, deferredBy: { select: { name: true } } },
    });

    broadcast({ type: 'defect.updated', payload: { id: defect.id, status: defect.status } });
    await recordAudit(request, {
      action: 'defect.deferred',
      entityType: 'Defect',
      entityId: defect.id,
      summary: `${defect.reference} (${defect.aircraft.registration}) deferred under ${deferralRef}, expires ${expiresAt.toISOString().slice(0, 10)}`,
      before: { status: existing.status, dueAt: existing.dueAt?.toISOString() ?? null },
      after: { status: 'DEFERRED', deferralRef, deferralExpiresAt: expiresAt.toISOString() },
    });
    return { defect };
  });
}
