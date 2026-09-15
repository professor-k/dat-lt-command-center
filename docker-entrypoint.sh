#!/bin/sh
set -e

SCHEMA=server/prisma/schema.prisma

# Databases created by the original `db push` deployments have our tables but no migration
# history, and `migrate deploy` refuses to touch them (P3005). Tell it, once, that the
# initial migration is already in place. Prints OK for both empty and already-migrated
# databases, so this is a no-op everywhere else. Remove once no such database is left.
if [ "$(node server/dist/baseline.js)" = "BASELINE_REQUIRED" ]; then
  echo "[boot] database predates migrations; recording the initial migration as applied"
  npx prisma migrate resolve --applied 20260915213635_init --schema="$SCHEMA"
fi

# Apply any migrations the image was built with, then load reference data on first boot.
# `migrate deploy` only ever runs committed migrations forward: it never drops a column
# to make the database match the schema, which `db push --accept-data-loss` would.
echo "[boot] applying database migrations"
npx prisma migrate deploy --schema="$SCHEMA"

if [ "${SEED_ON_BOOT}" = "true" ]; then
  echo "[boot] checking reference data"
  node server/dist/seed.js
fi

echo "[boot] starting API"
exec node server/dist/index.js
