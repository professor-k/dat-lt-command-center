import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Local development keeps its configuration in server/.env. Neither tsx nor node
// reads that file on its own, so load it here before validating. Variables already
// present in the real environment win, which leaves container and Railway
// deployments (where the platform injects them) untouched.
// src/env.ts and dist/env.js both sit one level under server/.
const envFile = join(dirname(fileURLToPath(import.meta.url)), '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** The demo account, for local development only — see the production refinement below. */
const DEMO_ADMIN_EMAIL = 'ops@dat-lt.aero';
const DEMO_ADMIN_PASSWORD = 'CommandCenter2026!';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  // Comma separated list of extra allowed browser origins (the SPA is same-origin in prod).
  CORS_ORIGINS: z.string().optional(),
  SEED_ADMIN_EMAIL: z.string().email().default(DEMO_ADMIN_EMAIL),
  SEED_ADMIN_PASSWORD: z.string().min(8).default(DEMO_ADMIN_PASSWORD),
  // How a self-service password reset is delivered. 'none' turns the feature off and leaves
  // admin reset as the way back into an account; 'log' writes the link to the server log
  // for local development. See mail.ts — there is no SMTP implementation yet.
  MAIL_TRANSPORT: z.enum(['none', 'log']).default('none'),
  // Base URL the reset link points at. Same-origin deployments need nothing here.
  PUBLIC_URL: z.string().url().optional(),
});

/**
 * The demo credentials are published in the README, which is fine for a machine on
 * somebody's desk and not fine for a deployment. A production boot has to name its own
 * first administrator rather than fall back to a password anyone can look up.
 */
export const envSchema = schema.superRefine((config, ctx) => {
  if (config.NODE_ENV !== 'production') return;

  for (const [key, demo] of [
    ['SEED_ADMIN_EMAIL', DEMO_ADMIN_EMAIL],
    ['SEED_ADMIN_PASSWORD', DEMO_ADMIN_PASSWORD],
  ] as const) {
    if (config[key] === demo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `must be set in production — the default is the published demo credential`,
      });
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
