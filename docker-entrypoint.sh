#!/bin/sh
set -e

# Apply any migrations the image was built with, then load reference data on first boot.
# `migrate deploy` only ever runs committed migrations forward: it never drops a column
# to make the database match the schema, which `db push --accept-data-loss` would.
echo "[boot] applying database migrations"
npx prisma migrate deploy --schema=server/prisma/schema.prisma

if [ "${SEED_ON_BOOT}" = "true" ]; then
  echo "[boot] checking reference data"
  node server/dist/seed.js
fi

echo "[boot] starting API"
exec node server/dist/index.js
