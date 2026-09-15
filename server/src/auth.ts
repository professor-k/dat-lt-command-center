import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    user: { sub: string; email: string; name: string; role: Role };
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; name: string; role: Role };
    user: { sub: string; email: string; name: string; role: Role };
  }
}

/** Rejects the request unless it carries a valid bearer token (or auth cookie). */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Valid session required' });
  }
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
