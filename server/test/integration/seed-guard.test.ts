import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { prisma, resetDatabase } from '../helpers/db.js';
import { DEMO_ADMIN_PASSWORD } from '../../src/demo-credentials.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const seedScript = join(here, '../../src/seed.ts');

// tsx hoists to the workspace root in this monorepo, but need not.
const tsxCli = [join(here, '../../../node_modules/tsx/dist/cli.mjs'), join(here, '../../node_modules/tsx/dist/cli.mjs')].find(existsSync)!;

/** The seed's stderr, or '' when it exited cleanly. */
async function seedStderr(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? (error as Error).message);
  }
}

/**
 * The seed refuses to give a production deployment an administrator whose password is
 * printed in the README.
 *
 * The check sits here rather than in the environment schema because only here is it known
 * that the credential is about to be used. A deployment seeded months ago never reads these
 * variables at all, and failing its boot over them — as an earlier version of this guard
 * did — breaks a running service to protect it from something that cannot happen.
 *
 * Driven as a subprocess because that is how it actually runs: `docker-entrypoint.sh` calls
 * the seed as its own process before the API starts.
 */
describe('seed credential guard', () => {
  const seed = (env: Record<string, string>) =>
    run(process.execPath, [tsxCli, seedScript], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
        SEED_FORCE: 'false',
        ...env,
      },
    });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses to seed a production database with the published password', async () => {
    expect(await seedStderr(seed({ NODE_ENV: 'production' }))).toMatch(/published demo administrator password/);

    // Nothing was written: the refusal comes before any account is created.
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.aircraft.count()).toBe(0);
  });

  it('names the way out in the refusal', async () => {
    expect(await seedStderr(seed({ NODE_ENV: 'production' }))).toMatch(/SEED_ADMIN_PASSWORD/);
  });

  it('refuses when only the address was changed', async () => {
    const stderr = await seedStderr(seed({ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'ops@airline.example' }));
    expect(stderr).toMatch(/published demo administrator password/);
  });

  it('seeds a production database given credentials of its own', async () => {
    await seed({
      NODE_ENV: 'production',
      SEED_ADMIN_EMAIL: 'ops@airline.example',
      SEED_ADMIN_PASSWORD: 'a-password-nobody-published',
    });

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'ops@airline.example' } });
    expect(admin.role).toBe('ADMIN');
  });

  it('leaves development alone', async () => {
    await seed({ NODE_ENV: 'development' });

    const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    expect(admin.email).toBe('ops@dat-lt.aero');
    expect(DEMO_ADMIN_PASSWORD).toBeTruthy();
  });

  /**
   * The case that matters for a deployment already running on the demo data: the seed skips
   * before it ever looks at the credentials, so a boot that changes nothing is not failed.
   */
  it('does not fail a production boot whose database is already seeded', async () => {
    await seed({ NODE_ENV: 'development' });
    const before = await prisma.user.count();

    const { stdout } = await seed({ NODE_ENV: 'production' });

    expect(stdout).toContain('Seed skipped');
    expect(await prisma.user.count()).toBe(before);
  });

  it('still refuses a forced reseed of a production database', async () => {
    await seed({ NODE_ENV: 'development' });

    // SEED_FORCE rebuilds the dataset from scratch, so the credential is live again.
    const stderr = await seedStderr(seed({ NODE_ENV: 'production', SEED_FORCE: 'true' }));
    expect(stderr).toMatch(/published demo administrator password/);
  });
});
