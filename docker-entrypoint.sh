#!/bin/sh
set -e

# Bring the database schema up to date, then load reference data on first boot.
echo "[boot] syncing database schema"
npx prisma db push --schema=server/prisma/schema.prisma --skip-generate --accept-data-loss

if [ "${SEED_ON_BOOT}" = "true" ]; then
  echo "[boot] checking reference data"
  node server/dist/seed.js
fi

echo "[boot] starting API"
exec node server/dist/index.js
