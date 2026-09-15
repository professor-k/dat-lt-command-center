import type { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { canSendMail, mailTransport } from '../mail.js';
import { authenticate, requireRole, STREAM_TICKET_TTL, STREAM_TICKET_TYPE } from '../auth.js';
import { broadcast } from '../events.js';
import { changedFields, recordAudit } from '../audit.js';

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

const forgotBody = z.object({ email: z.string().email() });

const resetBody = z.object({ token: z.string().min(16), newPassword: passwordField });

/** Long enough to walk to a desk and read the mail, short enough not to linger. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Reset tokens are stored as a digest, never in the clear. A plain SHA-256 is right here
 * where bcrypt is not: the token is 32 random bytes, so there is nothing to brute-force,
 * and the lookup has to be exact rather than slow.
 */
const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex');

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

/** How long a session lasts before it has to be refreshed or re-established. */
const SESSION_TTL = '12h';

export async function authRoutes(app: FastifyInstance) {
  // `issuedAtMs` is the session's own timestamp, carried because the standard `iat` claim
  // is only accurate to the second — too coarse for `sessionsValidFrom` to revoke against.
  const signSession = (user: { id: string; email: string; name: string; role: Role }) =>
    app.jwt.sign(
      { sub: user.id, email: user.email, name: user.name, role: user.role, issuedAtMs: Date.now() },
      { expiresIn: SESSION_TTL },
    );

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

    const token = signSession(user);
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.get('/me', { preHandler: authenticate }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.sub },
      select: publicUser,
    });
    return { user };
  });

  /**
   * Anyone may rotate their own password, and must prove the current one to do it.
   *
   * Changing the password signs every session out, which includes the one making the
   * request — so a fresh token comes back with the response. The device doing the work
   * stays signed in; anyone holding a token for this account elsewhere does not.
   */
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
      data: {
        passwordHash: await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST),
        sessionsValidFrom: new Date(),
      },
    });
    return { token: signSession(user) };
  });

  /** Signs this account out everywhere by invalidating every token issued so far. */
  app.post('/logout', { preHandler: authenticate }, async (request, reply) => {
    await prisma.user.update({
      where: { id: request.user.sub },
      data: { sessionsValidFrom: new Date() },
    });
    return reply.code(204).send();
  });

  /**
   * Extends a still-valid session. A twelve-hour token handed out at the start of a shift
   * would otherwise expire in the middle of one; the client renews in the background.
   * A session that has been revoked cannot renew — `authenticate` has already refused it.
   */
  app.post('/refresh', { preHandler: authenticate }, async (request) => {
    const { sub, email, name, role } = request.user;
    return { token: signSession({ id: sub, email, name, role }) };
  });

  /**
   * A short-lived credential for opening the event stream.
   *
   * EventSource cannot set headers, so whatever authorises the stream travels in the query
   * string — and query strings are written to access logs, at the proxy as well as here.
   * A session token would sit in those logs for its full twelve hours; this one is spent
   * within the minute. It is reusable inside that window, so the browser's own reconnect
   * still works, and it authorises nothing but the stream.
   */
  app.post('/stream-ticket', { preHandler: authenticate }, async (request) => {
    return {
      ticket: app.jwt.sign(
        { sub: request.user.sub, typ: STREAM_TICKET_TYPE },
        { expiresIn: STREAM_TICKET_TTL },
      ),
      expiresInSeconds: 30,
    };
  });

  /**
   * Starts a self-service password reset.
   *
   * Always answers the same way, whatever the address: telling an anonymous caller whether
   * an address is registered is a way to enumerate the staff list. When no mail transport
   * is configured nothing is sent and the answer still does not change — the response says
   * what will happen either way, and an administrator reset remains the way back in.
   */
  app.post('/forgot', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = forgotBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', message: 'A valid email address is required' });

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });

    if (user?.active && mailTransport) {
      // The database keeps only a hash: a stolen backup should not be a stack of live
      // reset links. What goes in the mail is the one copy that works.
      const token = randomBytes(32).toString('base64url');
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });

      const link = `${env.PUBLIC_URL ?? ''}/reset-password?token=${token}`;
      await mailTransport.send(
        {
          to: user.email,
          subject: 'DAT LT Command Center — password reset',
          body: `A password reset was requested for this account.\n\n${link}\n\nThe link is good for one hour and can be used once. If this was not you, nothing has changed.`,
        },
        request.log,
      );
    }

    return {
      message: canSendMail
        ? 'If that address has an account, a reset link is on its way.'
        : 'Password resets by email are not configured here — ask an administrator to reset your password.',
    };
  });

  /** Completes a reset. The token proves the address, so no current password is asked for. */
  app.post('/reset', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = resetBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(parsed.data.token) },
      include: { user: { select: { id: true, active: true } } },
    });

    // One message for every way a token can be no good, so a failed attempt says nothing
    // about whether the token ever existed.
    const unusable = !record || record.usedAt !== null || record.expiresAt < new Date() || !record.user.active;
    if (unusable) {
      return reply.code(400).send({ error: 'BadRequest', message: 'That reset link is no longer valid; request a new one' });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST),
          // Whoever was in the account on the old password is now out of it.
          sessionsValidFrom: new Date(),
        },
      }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      // Any other outstanding link for this account is spent too.
      prisma.passwordResetToken.updateMany({
        where: { userId: record.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);

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
    await recordAudit(request, {
      action: 'user.created',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.email} added as ${user.role}`,
      after: { email: user.email, name: user.name, role: user.role, active: user.active },
    });
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

    const deactivated = existing.active && !user.active;
    const reactivated = !existing.active && user.active;
    const changes = [
      existing.role !== user.role ? `role ${existing.role} → ${user.role}` : null,
      deactivated ? 'deactivated' : reactivated ? 'reactivated' : null,
      existing.name !== user.name ? `renamed to ${user.name}` : null,
    ].filter(Boolean);

    await recordAudit(request, {
      action: deactivated ? 'user.deactivated' : reactivated ? 'user.reactivated' : 'user.updated',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.email}: ${changes.length ? changes.join(', ') : 'record updated'}`,
      ...changedFields(
        { name: existing.name, role: existing.role, active: existing.active },
        { name: user.name, role: user.role, active: user.active },
        ['name', 'role', 'active'],
      ),
    });
    return { user };
  });

  /** Admin reset, for someone who has locked themselves out. */
  app.post('/users/:id/password', { preHandler: [authenticate, requireRole('ADMIN')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = resetPasswordBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BadRequest', issues: parsed.error.issues });

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NotFound', message: 'User not found' });

    // A reset exists to take an account back from whoever is holding it, so it signs the
    // account out everywhere rather than leaving live sessions running on the old password.
    await prisma.user.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST),
        sessionsValidFrom: new Date(),
      },
    });

    broadcast({ type: 'user.updated', payload: { id, passwordReset: true } });
    // The password itself never reaches the log — only that it was reset, by whom.
    await recordAudit(request, {
      action: 'user.password_reset',
      entityType: 'User',
      entityId: id,
      summary: `Password reset for ${existing.email}`,
    });
    return reply.code(204).send();
  });
}
