import type { FastifyRequest } from 'fastify';
import { prisma } from './db.js';

type Json = Record<string, unknown> | null;

export interface AuditEntry {
  action: string;
  entityType: 'Aircraft' | 'Station' | 'Impediment' | 'PredictiveAlert' | 'Defect' | 'DefectHistory' | 'User';
  entityId: string;
  /** One rendered line — what a person reading the log needs, without joining anything. */
  summary: string;
  before?: Json;
  after?: Json;
}

/**
 * Records a change against the actor who made it. Called after the write succeeds,
 * next to the broadcast.
 *
 * Failures are swallowed on purpose: an audit problem must not turn a successful
 * maintenance action into an error the engineer sees. They are logged instead, so a
 * silently failing audit trail is still visible in the server log.
 */
export async function recordAudit(request: FastifyRequest, entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: request.user.sub,
        actorEmail: request.user.email,
        actorRole: request.user.role,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.summary,
        before: (entry.before ?? undefined) as never,
        after: (entry.after ?? undefined) as never,
      },
    });
  } catch (err) {
    request.log.error({ err, entry }, 'failed to record audit entry');
  }
}

/** Only the fields that actually changed, for a compact before/after pair. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: (keyof T)[],
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};

  for (const key of keys) {
    const a = before[key] instanceof Date ? (before[key] as Date).toISOString() : before[key];
    const b = after[key] instanceof Date ? (after[key] as Date).toISOString() : after[key];
    if (a !== b) {
      from[key as string] = a ?? null;
      to[key as string] = b ?? null;
    }
  }

  return { before: from, after: to };
}
