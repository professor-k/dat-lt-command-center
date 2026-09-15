import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { broadcast } from '../events.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const passwordField = z.string().min(8, 'Password must be at least 8 characters');

const createUserBody = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: passwordField,
  role: z.enum(['ADMIN', 'ENGINEER', 'VIEWER']).default('VIEWER'),
});

const patchUserBody = z
  .object({
    name: z.string().min(2).optional(),
    role: z.enum(['ADMIN', 'ENGINEER', 'VIEWER']).optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordField,
});

const resetPasswordBody = z.object({ newPassword: passwordField });

const publicUser = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

/** Hashing cost, matching the seed. Deliberately slow. */
const BCRYPT_COST = 10;

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', message: 'Email and password required' });

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Constant-ish work either way so a missing account is not distinguishable by timing.
    const ok = user ? await bcrypt.compare(password, user.passwordHash) : await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    if (!user || !ok) return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });

    // Checked only after the password, so a deactivated account is not a way to probe
    // which addresses are registered.
    if (!user.active) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'This account has been deactivated' });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const token = app.jwt.sign(
      { sub: user.id, email: user.email, name: user.name, role: user.role },
      { expiresIn: '12h' },
    );
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.get('/me', { preHandler: authenticate }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.sub },
      select: publicUser,
    });
    return { user };
  });

  /** Anyone may rotate their own password, and must prove the current one to do it. */
  app.post('/password', { preHandler: authenticate }, async (request, reply) => {
    const parsed = changePasswordBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!user) return reply.code(404).send({ error: 'NotFound', message: 'Account not found' });

    if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Current password is incorrect' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST) },
    });
    return reply.code(204).send();
  });

  app.get('/users', { preHandler: [authenticate, requireRole('ADMIN')] }, async () => {
    const users = await prisma.user.findMany({
      select: publicUser,
      orderBy: { createdAt: 'asc' },
    });
    return { users };
  });

  app.post('/users', { preHandler: [authenticate, requireRole('ADMIN')] }, async (request, reply) => {
    const parsed = createUserBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const { email, name, password, role } = parsed.data;
    const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (exists) return reply.code(409).send({ error: 'Conflict', message: 'Email already registered' });

    const user = await prisma.user.create({
      data: { email: email.toLowerCase(), name, role, passwordHash: await bcrypt.hash(password, BCRYPT_COST) },
      select: publicUser,
    });

    broadcast({ type: 'user.created', payload: { id: user.id, email: user.email } });
    return reply.code(201).send({ user });
  });

  /**
   * Accounts are edited, not removed. Two things are refused outright: acting on your own
   * role or access, and taking away the last way into the system.
   */
  app.patch('/users/:id', { preHandler: [authenticate, requireRole('ADMIN')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchUserBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'User not found' });

    const { name, role, active } = parsed.data;
    const losingAdmin = existing.role === 'ADMIN' && ((role !== undefined && role !== 'ADMIN') || active === false);

    if (id === request.user.sub && (role !== undefined && role !== existing.role)) {
      return reply.code(409).send({ error: 'Conflict', message: 'You cannot change your own role' });
    }
    if (id === request.user.sub && active === false) {
      return reply.code(409).send({ error: 'Conflict', message: 'You cannot deactivate your own account' });
    }

    if (losingAdmin) {
      const remaining = await prisma.user.count({ where: { role: 'ADMIN', active: true, id: { not: id } } });
      if (remaining === 0) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'This is the last active administrator; promote someone else first',
        });
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: { ...(name !== undefined ? { name } : {}), ...(role !== undefined ? { role } : {}), ...(active !== undefined ? { active } : {}) },
      select: publicUser,
    });

    broadcast({ type: 'user.updated', payload: { id: user.id, role: user.role, active: user.active } });
    return { user };
  });

  /** Admin reset, for someone who has locked themselves out. */
  app.post('/users/:id/password', { preHandler: [authenticate, requireRole('ADMIN')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = resetPasswordBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'User not found' });

    await prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST) },
    });

    broadcast({ type: 'user.updated', payload: { id, passwordReset: true } });
    return reply.code(204).send();
  });
}
