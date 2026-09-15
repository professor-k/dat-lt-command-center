import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/env.js';

/**
 * The demo administrator's credentials are printed in the README, which is right for a
 * machine on somebody's desk and wrong for a deployment. A production boot has to name its
 * own first administrator rather than quietly fall back to a password anyone can look up.
 */
describe('environment configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/datlt',
    JWT_SECRET: 'a-long-enough-development-secret',
  };

  const issuesFor = (env: Record<string, string>) => {
    const parsed = envSchema.safeParse(env);
    return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'));
  };

  it('lets development fall back to the demo administrator', () => {
    expect(issuesFor({ ...base, NODE_ENV: 'development' })).toEqual([]);
  });

  it('refuses to boot production on the published demo credentials', () => {
    const issues = issuesFor({ ...base, NODE_ENV: 'production' });

    expect(issues).toContain('SEED_ADMIN_EMAIL');
    expect(issues).toContain('SEED_ADMIN_PASSWORD');
  });

  it('refuses production with only the address changed', () => {
    const issues = issuesFor({ ...base, NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'ops@airline.example' });

    expect(issues).not.toContain('SEED_ADMIN_EMAIL');
    expect(issues).toContain('SEED_ADMIN_PASSWORD');
  });

  it('accepts production once both are named', () => {
    const issues = issuesFor({
      ...base,
      NODE_ENV: 'production',
      SEED_ADMIN_EMAIL: 'ops@airline.example',
      SEED_ADMIN_PASSWORD: 'a-password-nobody-published',
    });

    expect(issues).toEqual([]);
  });

  it('still requires the things it always required', () => {
    expect(issuesFor({ NODE_ENV: 'development' })).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'JWT_SECRET']),
    );
  });

  it('keeps mail delivery off unless it is asked for', () => {
    const parsed = envSchema.safeParse({ ...base, NODE_ENV: 'development' });
    expect(parsed.success && parsed.data.MAIL_TRANSPORT).toBe('none');
  });
});
