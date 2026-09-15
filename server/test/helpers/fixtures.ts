import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { DefectCategory, OperationalStatus, Role } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { prisma } from './db.js';

/** A silent app with throttling off, so a busy suite fails on behaviour, not rate limits. */
export function testApp(): Promise<FastifyInstance> {
  return buildApp({ logger: false, rateLimiting: false });
}

const PASSWORD = 'TestPassword123!';

export async function createUser(role: Role, email = `${role.toLowerCase()}@test.aero`) {
  return prisma.user.create({
    data: {
      email,
      name: `${role} User`,
      role,
      // Cost 4 rather than the production 10: these hashes are created and compared
      // hundreds of times across the suite and bcrypt is deliberately slow.
      passwordHash: await bcrypt.hash(PASSWORD, 4),
    },
  });
}

/** Creates a user of the given role and returns a bearer token for them. */
export async function tokenFor(app: FastifyInstance, role: Role): Promise<string> {
  const user = await createUser(role);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: user.email, password: PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed for ${role}: ${response.statusCode} ${response.body}`);
  }
  return response.json().token;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function createStation(code = 'MXP', city = 'Milan') {
  return prisma.station.create({ data: { code, city } });
}

export async function createAircraft(
  registration = 'LY-TST',
  options: { stationId?: string; operationalStatus?: OperationalStatus } = {},
) {
  return prisma.aircraft.create({
    data: {
      registration,
      model: 'ATR 72-600',
      operationalStatus: options.operationalStatus ?? 'ACTIVE',
      ...(options.stationId ? { stationId: options.stationId } : {}),
    },
  });
}

export async function createDefect(
  aircraftId: string,
  options: { category?: DefectCategory; reference?: string; status?: 'OPEN' | 'DEFERRED' | 'CLOSED' } = {},
) {
  return prisma.defect.create({
    data: {
      reference: options.reference ?? `DEF-TEST-${Math.random().toString(36).slice(2, 8)}`,
      aircraftId,
      ataChapter: '36',
      title: 'Test defect',
      category: options.category ?? 'CAT_C',
      status: options.status ?? 'OPEN',
    },
  });
}
