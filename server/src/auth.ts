import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { prisma } from './db.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The JWT claims while unverified; replaced with the live account by `authenticate`. */
    user: { sub: string; email: string; name: string; role: Role; iat?: number; issuedAtMs?: number };
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; name: string; role: Role; issuedAtMs: number };
    user: { sub: string; email: string; name: string; role: Role; iat?: number; issuedAtMs?: number };
  }
}

const unauthorized = (reply: FastifyReply, message: string) =>
  reply.code(401).send({ error: 'Unauthorized', message });

/**
 * Rejects the request unless it carries a valid bearer token for an account that is still
 * allowed in.
 *
 * A signature check alone is not enough: the token is minted for twelve hours, so an
 * account deactivated or demoted through Access Control would keep working until it
 * expired. The account is re-read on every request and the live record wins over whatever
 * the token was minted with — one indexed primary-key lookup, which at this scale is
 * cheaper than the alternative of explaining why revoking access did not revoke access.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return unauthorized(reply, 'Valid session required');
  }

  // Captured before request.user is replaced below. The standard `iat` claim is whole
  // seconds, which is too coarse to tell a token apart from a revocation in the same
  // second, so sessions carry their own millisecond stamp; `iat` is the fallback for a
  // token minted before that claim existed.
  const issuedAt = request.user.issuedAtMs ?? (request.user.iat ?? 0) * 1000;

  const account = await prisma.user.findUnique({
    where: { id: request.user.sub },
    select: { id: true, email: true, name: true, role: true, active: true, sessionsValidFrom: true },
  });

  if (!account || !account.active) {
    return unauthorized(reply, 'This session is no longer valid; sign in again');
  }

  if (account.sessionsValidFrom && issuedAt < account.sessionsValidFrom.getTime()) {
    return unauthorized(reply, 'This session has been signed out; sign in again');
  }

  request.user = { sub: account.id, email: account.email, name: account.name, role: account.role };
}

/** Composable guard: requires one of the given roles. Use after `authenticate`. */
export function requireRole(...roles: Role[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user || !roles.includes(request.user.role)) {
      return reply
        .code(403)
        .send({ error: 'Forbidden', message: `Requires role: ${roles.join(' or ')}` });
    }
  };
}

export function registerAuthHooks(app: FastifyInstance) {
  app.decorate('authenticate', authenticate);
}
