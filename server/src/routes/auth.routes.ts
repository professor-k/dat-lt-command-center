import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireRole } from '../auth.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const createUserBody = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(8),
  role: z.enum(['ADMIN', 'ENGINEER', 'VIEWER']).default('VIEWER'),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', message: 'Email and password required' });

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Constant-ish work either way so a missing account is not distinguishable by timing.
    const ok = user ? await bcrypt.compare(password, user.passwordHash) : await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    if (!user || !ok) return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });

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
      select: { id: true, email: true, name: true, role: true, lastLoginAt: true },
    });
    return { user };
  });

  app.get('/users', { preHandler: [authenticate, requireRole('ADMIN')] }, async () => {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, lastLoginAt: true, createdAt: true },
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
      data: { email: email.toLowerCase(), name, role, passwordHash: await bcrypt.hash(password, 10) },
      select: { id: true, email: true, name: true, role: true },
    });
    return reply.code(201).send({ user });
  });
}
