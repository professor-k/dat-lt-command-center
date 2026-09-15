import { defineConfig } from 'vitest/config';

/**
 * Integration tests talk to a real PostgreSQL, because the rules worth protecting here —
 * cascades, unique constraints, the two 409 refusals — only exist against a real database.
 * CI and developers point TEST_DATABASE_URL at their own instance; the default matches the
 * throwaway container described in the README.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:devpass@127.0.0.1:55433/datlt_test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The suite shares one database, so files must not run concurrently against it.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'test-secret-that-is-long-enough-to-pass',
    },
  },
});
