import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, resetDatabase } from '../helpers/db.js';
import { auth, createUser, testApp, tokenFor } from '../helpers/fixtures.js';

/**
 * Accounts are deactivated rather than deleted, and the system refuses to lock its last
 * administrator out of it.
 */
describe('user management', () => {
  let app: FastifyInstance;
  let admin: string;
  let adminId: string;

  beforeAll(async () => {
    app = await testApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await tokenFor(app, 'ADMIN');
    adminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.aero' } })).id;
  });

  const login = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  describe('creating and editing', () => {
    it('creates a user an admin can then sign in as', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/auth/users',
        headers: auth(admin),
        payload: { email: 'New.Engineer@dat-lt.aero', name: 'New Engineer', password: 'InitialPass123!', role: 'ENGINEER' },
      });
      expect(created.statusCode).toBe(201);
      // Addresses are normalised so case cannot create a second account.
      expect(created.json().user.email).toBe('new.engineer@dat-lt.aero');

      const signedIn = await login('new.engineer@dat-lt.aero', 'InitialPass123!');
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json().user.role).toBe('ENGINEER');
    });

    it('never returns a password hash', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/auth/users', headers: auth(admin) });
      expect(response.statusCode).toBe(200);
      expect(JSON.stringify(response.json())).not.toMatch(/passwordHash|\$2[aby]\$/);
    });

    it('refuses a duplicate address', async () => {
      const payload = { email: 'dupe@dat-lt.aero', name: 'First', password: 'InitialPass123!' };
      expect((await app.inject({ method: 'POST', url: '/api/auth/users', headers: auth(admin), payload })).statusCode).toBe(201);
      const second = await app.inject({ method: 'POST', url: '/api/auth/users', headers: auth(admin), payload });
      expect(second.statusCode).toBe(409);
    });

    it('rejects a password shorter than 8 characters', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/users',
        headers: auth(admin),
        payload: { email: 'weak@dat-lt.aero', name: 'Weak Pass', password: 'short' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('changes a role', async () => {
      const viewer = await createUser('VIEWER');
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/auth/users/${viewer.id}`,
        headers: auth(admin),
        payload: { role: 'ENGINEER' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.role).toBe('ENGINEER');
    });

    it('stops a non-admin managing users', async () => {
      const engineer = await tokenFor(app, 'ENGINEER');
      expect((await app.inject({ method: 'GET', url: '/api/auth/users', headers: auth(engineer) })).statusCode).toBe(403);
    });
  });

  describe('deactivation', () => {
    it('locks a deactivated user out', async () => {
      const engineer = await createUser('ENGINEER');
      expect((await login(engineer.email, 'TestPassword123!')).statusCode).toBe(200);

      const deactivated = await app.inject({
        method: 'PATCH',
        url: `/api/auth/users/${engineer.id}`,
        headers: auth(admin),
        payload: { active: false },
      });
      expect(deactivated.statusCode).toBe(200);

      const blocked = await login(engineer.email, 'TestPassword123!');
      expect(blocked.statusCode).toBe(401);
      expect(blocked.json().message).toMatch(/deactivated/i);
    });

    it('lets a reactivated user back in', async () => {
      const engineer = await createUser('ENGINEER');
      const patch = (active: boolean) =>
        app.inject({ method: 'PATCH', url: `/api/auth/users/${engineer.id}`, headers: auth(admin), payload: { active } });

      await patch(false);
      await patch(true);

      expect((await login(engineer.email, 'TestPassword123!')).statusCode).toBe(200);
    });

    it('keeps the defects a deactivated user raised', async () => {
      const engineer = await createUser('ENGINEER');
      const aircraft = await prisma.aircraft.create({ data: { registration: 'LY-HIST', model: 'ATR 72-600' } });
      await prisma.defect.create({
        data: { reference: 'DEF-KEEP-1', aircraftId: aircraft.id, ataChapter: '36', title: 'Raised then left', raisedById: engineer.id },
      });

      await app.inject({ method: 'PATCH', url: `/api/auth/users/${engineer.id}`, headers: auth(admin), payload: { active: false } });

      const defect = await prisma.defect.findFirstOrThrow({ where: { reference: 'DEF-KEEP-1' }, include: { raisedBy: true } });
      expect(defect.raisedBy?.name).toBe('ENGINEER User');
    });
  });

  describe('protecting access', () => {
    it('refuses to let an admin deactivate themselves', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/auth/users/${adminId}`,
        headers: auth(admin),
        payload: { active: false },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toMatch(/your own account/i);
    });

    it('refuses to let an admin change their own role', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/auth/users/${adminId}`,
        headers: auth(admin),
        payload: { role: 'VIEWER' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toMatch(/your own role/i);
    });

    it('refuses to demote the last active administrator', async () => {
      const second = await createUser('ADMIN', 'second.admin@test.aero');
      const secondToken = (await login(second.email, 'TestPassword123!')).json().token;

      // The second admin demotes the first, leaving only themselves.
      expect(
        (await app.inject({
          method: 'PATCH',
          url: `/api/auth/users/${adminId}`,
          headers: auth(secondToken),
          payload: { role: 'ENGINEER' },
        })).statusCode,
      ).toBe(200);

      // Nobody is left to demote them, and they cannot do it to themselves.
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/auth/users/${second.id}`,
        headers: auth(secondToken),
        payload: { role: 'VIEWER' },
      });
      expect(response.statusCode).toBe(409);
      expect(await prisma.user.count({ where: { role: 'ADMIN', active: true } })).toBe(1);
    });

    it('lets an admin still edit their own name', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/auth/users/${adminId}`,
        headers: auth(admin),
        payload: { name: 'Renamed Admin' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.name).toBe('Renamed Admin');
    });
  });

  describe('passwords', () => {
    it('lets anyone change their own password', async () => {
      const viewer = await createUser('VIEWER');
      const token = (await login(viewer.email, 'TestPassword123!')).json().token;

      const changed = await app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: auth(token),
        payload: { currentPassword: 'TestPassword123!', newPassword: 'BrandNewPass456!' },
      });
      // A replacement token comes back, because the change signs every session out and the
      // caller's is one of them. Revocation itself is covered in session-revocation.test.ts.
      expect(changed.statusCode).toBe(200);
      expect(changed.json().token).toEqual(expect.any(String));

      expect((await login(viewer.email, 'TestPassword123!')).statusCode).toBe(401);
      expect((await login(viewer.email, 'BrandNewPass456!')).statusCode).toBe(200);
    });

    it('requires the current password to be correct', async () => {
      const viewer = await createUser('VIEWER');
      const token = (await login(viewer.email, 'TestPassword123!')).json().token;

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: auth(token),
        payload: { currentPassword: 'WrongPassword!', newPassword: 'BrandNewPass456!' },
      });

      expect(response.statusCode).toBe(403);
      expect((await login(viewer.email, 'TestPassword123!')).statusCode).toBe(200);
    });

    it('lets an admin reset a locked-out user', async () => {
      const engineer = await createUser('ENGINEER');

      const reset = await app.inject({
        method: 'POST',
        url: `/api/auth/users/${engineer.id}/password`,
        headers: auth(admin),
        payload: { newPassword: 'ResetByAdmin789!' },
      });
      expect(reset.statusCode).toBe(204);

      expect((await login(engineer.email, 'ResetByAdmin789!')).statusCode).toBe(200);
    });

    it('stops a non-admin resetting someone else', async () => {
      const target = await createUser('VIEWER');
      const engineer = await tokenFor(app, 'ENGINEER');

      const response = await app.inject({
        method: 'POST',
        url: `/api/auth/users/${target.id}/password`,
        headers: auth(engineer),
        payload: { newPassword: 'NotAllowed123!' },
      });
      expect(response.statusCode).toBe(403);
    });
  });
});
