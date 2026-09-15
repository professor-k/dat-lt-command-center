# DAT LT — Outstation Command Center

A line-maintenance control application for an airline's outstation network: live fleet
telemetry, MEL-categorised defect management, predictive component risk, and station
readiness across the Italian network.

The UI is a production build of the original `docs/Luxury-Dashboard.mockup.html` concept —
deep-space glassmorphism, gold and violet accents, neon status telemetry — backed by a real
API, database and role-based access control.

## Stack

| Layer      | Choice                                                 |
| ---------- | ------------------------------------------------------ |
| Frontend   | React 19, Vite 6, TanStack Query, React Router          |
| API        | Fastify 5 (TypeScript, ESM), Zod validation             |
| Database   | PostgreSQL via Prisma 6                                 |
| Auth       | JWT bearer tokens, bcrypt hashes, three roles           |
| Realtime   | Server-Sent Events (`/api/stream`) + query invalidation |
| Deployment | Single Docker image on Railway (API serves the SPA)     |

## Domain model

- **Aircraft** — registration, model, hours/cycles, operational status (`ACTIVE`, `AOG`,
  `MAINTENANCE`, `STORED`), current station.
- **Defect** — ATA chapter, MEL category (`CRITICAL`…`CAT_D`), status, repetitive flag,
  rectification window. Raising a `CRITICAL` defect grounds the aircraft automatically;
  closing the last one releases it back to service.
- **PredictiveAlert** — component, severity, horizon in days, model confidence,
  recommendation. Drives the "Critical Predictive Risk" headline.
- **Station** — IATA code, network status, compliance/audit state, required action.
- **Impediment** — what is blocking a station (consumables, manpower, tooling…).
- **DefectHistory** — monthly counts that feed the year-end projection
  (`actual-to-date + run-rate × remaining months`). Maintained by hand from the
  "Edit baseline" control on the projection card, not derived from the defect log.

## Roles

| Role       | Capability                                                        |
| ---------- | ----------------------------------------------------------------- |
| `ADMIN`    | Everything, including user management (`/api/auth/users`)          |
| `ENGINEER` | Raise/close defects, move aircraft, manage stations & impediments  |
| `VIEWER`   | Read-only access to the whole command centre                       |

## API

```
POST   /api/auth/login              email + password -> JWT
GET    /api/auth/me                 current session
GET    /api/auth/users              (ADMIN)
POST   /api/auth/users              (ADMIN)
GET    /api/overview                KPI block: open/projected defects, top risk, availability
GET    /api/fleet                   telemetry rows
GET    /api/fleet/:registration     full technical record
POST   /api/fleet                   (ENGINEER+) add an airframe
PATCH  /api/fleet/:registration     (ENGINEER+) status / station / hours
DELETE /api/fleet/:registration     (ADMIN) remove an airframe with no technical record
GET    /api/defects                 ?status=&registration=&ataChapter=
POST   /api/defects                 (ENGINEER+)
PATCH  /api/defects/:id             (ENGINEER+) close / defer / reopen
GET    /api/stations                network status + open impediments
GET    /api/stations/:code
POST   /api/stations                (ADMIN) open a station
PATCH  /api/stations/:code          (ENGINEER+)
DELETE /api/stations/:code          (ADMIN) close a station with no aircraft on it
POST   /api/stations/:code/impediments   (ENGINEER+)
PATCH  /api/stations/impediments/:id     (ENGINEER+)
GET    /api/alerts                  predictive alerts
POST   /api/alerts                  (ENGINEER+) raise a prediction
PATCH  /api/alerts/:id              (ENGINEER+) acknowledge
DELETE /api/alerts/:id              (ENGINEER+) withdraw a prediction
GET    /api/history                 ?year= monthly defect baseline
PUT    /api/history                 (ENGINEER+) upsert one month
DELETE /api/history/:year/:month    (ENGINEER+) clear one month
GET    /api/stream                  SSE change feed
GET    /api/health                  liveness + DB check
```

## Removal rules

Nothing that carries a maintenance record can be deleted, because the technical log has
to outlive the UI that renders it:

| Action              | Refused when                              | Do this instead            |
| ------------------- | ----------------------------------------- | -------------------------- |
| Remove an aircraft  | it has any defect on file, open or closed | set it `STORED`            |
| Close a station     | aircraft are still based there            | move them, then close      |
| Withdraw an alert   | never — predictions are working estimates | —                          |

Both refusals return `409` with a message naming what is in the way.

## Local development

```bash
npm install

cat > server/.env <<'ENV'
DATABASE_URL=postgresql://user:pass@localhost:5432/datlt
JWT_SECRET=a-long-random-development-secret
ENV

npm run db:migrate   # apply migrations
npm run db:seed      # load the reference fleet and network
npm run dev          # API on :8080, Vite on :5173 (proxying /api)
```

### Schema changes

The schema is versioned as migrations under `server/prisma/migrations`. After editing
`schema.prisma`, generate the SQL and apply it locally with:

```bash
npm run db:migrate:dev -- --name describe_the_change
```

Commit the generated migration alongside the schema — deployments run `prisma migrate deploy`,
which only ever plays committed migrations forward and never drops a column to make the
database match. `npm run db:push` still exists for throwaway experiments, but anything that
reaches `main` needs a migration.

## Demo accounts

| Email                   | Password             | Role     |
| ----------------------- | -------------------- | -------- |
| `ops@dat-lt.aero`       | `CommandCenter2026!` | ADMIN    |
| `engineer@dat-lt.aero`  | `LineMaint2026!`     | ENGINEER |
| `viewer@dat-lt.aero`    | `FleetView2026!`     | VIEWER   |

Change these before using the deployment for anything real — set `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` before the first boot, or rotate via `POST /api/auth/users`.

## Deployment

The `Dockerfile` builds the SPA and the API into one image; `docker-entrypoint.sh` applies any
pending migrations, seeds on first boot when `SEED_ON_BOOT=true`, then serves everything from
one port. On Railway the service needs:

| Variable              | Value                                          |
| --------------------- | ---------------------------------------------- |
| `DATABASE_URL`        | `${{Postgres.DATABASE_URL}}`                   |
| `JWT_SECRET`          | long random string                             |
| `SEED_ON_BOOT`        | `true` (idempotent — skips if data exists)     |
| `NODE_ENV`            | `production`                                   |
| `PORT`                | provided by Railway                            |
| `CORS_ORIGINS`        | only if a browser on another origin calls the API — unset means same-origin only |

Set `SEED_FORCE=true` for one boot to rebuild the reference dataset from scratch.
