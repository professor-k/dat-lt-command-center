/**
 * One-time adoption check for databases that predate Prisma migrations.
 *
 * The first deployments of this app applied the schema with `prisma db push`, which
 * creates tables but no migration history. `prisma migrate deploy` refuses to run against
 * such a database (P3005: "database schema is not empty"), so it has to be told, once,
 * that the initial migration is already present.
 *
 * Prints BASELINE_REQUIRED only when the database is in exactly that state: our tables
 * exist, but nothing has ever been migrated. An empty database (a fresh deployment) and
 * an already-migrated one both print OK, so the entrypoint leaves them alone.
 *
 * Once every environment has migration history this file, its call in
 * docker-entrypoint.sh, and the baseline branch there can all be deleted.
 */
import { prisma } from './db.js';

const LEGACY_TABLE = 'Aircraft';

async function main() {
  const [{ exists: hasHistory }] = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    ) AS exists
  `;

  if (hasHistory) {
    console.log('OK');
    return;
  }

  const [{ exists: hasSchema }] = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${LEGACY_TABLE}
    ) AS exists
  `;

  // No history and no tables is simply a new database: migrate deploy builds it from scratch.
  console.log(hasSchema ? 'BASELINE_REQUIRED' : 'OK');
}

main()
  .catch((err) => {
    console.error('baseline check failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
