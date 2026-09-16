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

### Rectification windows and deferral

Each category carries its own window, and the deadline is derived from it — re-categorising a
defect moves its deadline with it:

| Category   | Window     |
| ---------- | ---------- |
| `CRITICAL` | no-go, now |
| `CAT_A`    | 1 day      |
| `CAT_B`    | 3 days     |
| `CAT_C`    | 10 days    |
| `CAT_D`    | 120 days   |

Deferring carries a defect forward under the Minimum Equipment List: it records the MEL
reference, the engineer approving it, an optional note, and an expiry that becomes the
defect's deadline in place of the category window. A `CRITICAL` defect is no-go by definition
and cannot be deferred — downgrade the category first. Bringing a deferred defect back to
`OPEN` drops the deferral and restores the category's own window.

Anything still open past its deadline is **out of MEL window**: counted on the overview and
listed, latest first, under `?overdue=true`.
- **PredictiveAlert** — component, severity, horizon in days, model confidence,
  recommendation. Drives the "Critical Predictive Risk" headline.
- **Station** — IATA code, network status, compliance/audit state, required action.
- **Impediment** — what is blocking a station (consumables, manpower, tooling…).
- **AuditLog** — who changed what, and when. Every mutation writes one entry with the actor,
  a rendered one-line summary and a before/after pair of just the fields that moved. The
  actor's address and role are copied in at write time so the trail still reads correctly
  after an account is renamed or deactivated. Read from **Change History** (ADMIN).
- **DefectHistory** — monthly counts that feed the year-end projection
  (`actual-to-date + run-rate × remaining months`). Maintained by hand from the
  "Edit baseline" control on the projection card, not derived from the defect log.

## Sessions

A session is a bearer token good for twelve hours, renewed in the background so it does not
expire mid-shift. Every request re-reads the account behind it, so deactivating or demoting
someone through Access Control takes effect on their next request rather than whenever their
token happens to run out. Changing a password, resetting one, and signing out all invalidate
every token issued for that account — a password change hands the device doing the work a
replacement, so it alone stays signed in.

The event stream is opened with a thirty-second ticket from `POST /api/auth/stream-ticket`
rather than the session token, because EventSource cannot set headers and query strings end
up in access logs.

Self-service password reset is off unless `MAIL_TRANSPORT` is configured; there is no SMTP
transport yet, so an administrator reset is the supported way back into an account. The
endpoints, single-use tokens and UI are in place behind that seam.

## Roles

| Role       | Capability                                                        |
| ---------- | ----------------------------------------------------------------- |
| `ADMIN`    | Everything, plus Access Control (accounts, roles, deactivation, password resets) and Change History |
| `ENGINEER` | Raise/close defects, move aircraft, manage stations & impediments  |
| `VIEWER`   | Read-only access to the whole command centre                       |

Every role can change its own password from the sidebar.

## API

```
POST   /api/auth/login              email + password -> JWT
GET    /api/auth/me                 current session
POST   /api/auth/logout             sign this account out everywhere
POST   /api/auth/refresh            extend a still-valid session
POST   /api/auth/stream-ticket      short-lived credential for /api/stream
POST   /api/auth/password           change your own password (returns a replacement token)
POST   /api/auth/forgot             request a reset link (see MAIL_TRANSPORT)
POST   /api/auth/reset              set a new password from a reset link
GET    /api/auth/users              (ADMIN)
POST   /api/auth/users              (ADMIN) add an account
PATCH  /api/auth/users/:id          (ADMIN) name / role / active
POST   /api/auth/users/:id/password (ADMIN) reset someone into their account
GET    /api/overview                KPI block: open/projected defects, top risk, availability
GET    /api/fleet                   telemetry rows
GET    /api/fleet/:registration     full technical record
POST   /api/fleet                   (ENGINEER+) add an airframe
PATCH  /api/fleet/:registration     (ENGINEER+) status / station / hours
DELETE /api/fleet/:registration     (ADMIN) remove an airframe with no technical record
GET    /api/defects                 ?status=&registration=&ataChapter=&overdue=
POST   /api/defects                 (ENGINEER+)
PATCH  /api/defects/:id             (ENGINEER+) close / reopen / re-categorise
POST   /api/defects/:id/defer       (ENGINEER+) carry forward under the MEL
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
GET    /api/audit                   (ADMIN) ?entityType=&entityId=&actorId=&action=&since=
                                    &take=&cursor= — paged, newest first
GET    /api/stream                  SSE change feed (?ticket=)
GET    /api/health                  liveness + DB check
```

## Removal rules

Nothing that carries a maintenance record can be deleted, because the technical log has
to outlive the UI that renders it:

| Action              | Refused when                              | Do this instead            |
| ------------------- | ----------------------------------------- | -------------------------- |
| Remove an aircraft  | it has any defect on file, open or closed | set it `STORED`            |
| Close a station     | aircraft are still based there            | move them, then close      |
| Remove a user       | always — defects name who raised them     | deactivate the account     |
| Withdraw an alert   | never — predictions are working estimates | —                          |

Each refusal returns `409` with a message naming what is in the way.

Accounts are deactivated rather than deleted: a deactivated user cannot sign in, but every
defect they raised or closed keeps their name on it. An administrator cannot change their own
role or deactivate themselves, and the last active administrator cannot be demoted — there is
always a way back into the system.

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

A database that predates the migrations — tables but no `_prisma_migrations` — makes
`migrate deploy` stop with P3005. Record the initial migration as already present once, with
`npx prisma migrate resolve --applied 20260915213635_init`, and normal deploys resume. No
such database is left, so this is only here in case an old dump is restored.

## Tests

```bash
npm run test:unit          # formulas only, no database
npm run test:integration   # real Fastify against a real PostgreSQL
npm test                   # both
```

Unit tests cover the year-end projection, the MEL rectification windows, the predictive
ranking, and the date helpers the UI renders deadlines with.

`npm run test:unit` also runs the web suite, which renders pages against a stubbed API in
jsdom: what each role is offered, the defect actions and the deferral form, the Access
Control guards, sign-in and password reset, and how the API client treats a 401.

Integration tests drive the app through `app.inject()` — no socket is bound — against a real
database, because the rules worth protecting are the ones only a real database enforces:
grounding on a CRITICAL defect and release on closing or downgrading the last one, both
removal refusals, the role guards, session revocation, reference allocation under
concurrency, the MEL paperwork a deferral cannot be had without, and the seed refusing to
give a production database the published demo administrator. They need a PostgreSQL with the schema applied:

```bash
docker run -d --name datlt-test -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=datlt_test -p 55433:5432 postgres:16-alpine

DATABASE_URL=postgresql://postgres:devpass@127.0.0.1:55433/datlt_test npm run db:migrate
```

Point `TEST_DATABASE_URL` at any other instance to override. The suite truncates every table
between tests, so do not aim it at a database you care about. CI runs the whole thing —
typecheck, both test layers, then the build — against a `postgres:16` service container.

## Demo accounts — local development only

| Email                   | Password             | Role     |
| ----------------------- | -------------------- | -------- |
| `ops@dat-lt.aero`       | `CommandCenter2026!` | ADMIN    |
| `engineer@dat-lt.aero`  | `LineMaint2026!`     | ENGINEER |
| `viewer@dat-lt.aero`    | `FleetView2026!`     | VIEWER   |

These are printed here, so they are not credentials — they are a convenience for a database
on your own machine, and the sign-in screen only offers them in a development build.

The seed **refuses to create them on a production database**: set `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` to something of your own first, or `SEED_ON_BOOT=false` and create the
first account another way. The refusal is raised where the credential would be used, not at
boot, so a deployment that was seeded long ago — where the seed skips and never reads those
variables — keeps starting normally. The demo engineer and viewer accounts can be
deactivated from Access Control once real people have accounts.

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
