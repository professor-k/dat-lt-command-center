import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * Empties every table between tests. TRUNCATE ... CASCADE is used rather than deleteMany
 * per model so the order of foreign keys does not have to be maintained by hand here.
 * _prisma_migrations is deliberately excluded — the schema must survive the reset.
 */
export async function resetDatabase() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
  `;
  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
