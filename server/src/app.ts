import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import { env, isProd } from './env.js';
import { prisma } from './db.js';
import { addClient, clientCount } from './events.js';
import { STREAM_TICKET_TYPE, type StreamTicket } from './auth.js';
import { authRoutes } from './routes/auth.routes.js';
import { fleetRoutes } from './routes/fleet.routes.js';
import { defectRoutes } from './routes/defects.routes.js';
import { stationRoutes } from './routes/stations.routes.js';
import { alertRoutes } from './routes/alerts.routes.js';
import { overviewRoutes } from './routes/overview.routes.js';
import { historyRoutes } from './routes/history.routes.js';
import { auditRoutes } from './routes/audit.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/app.js -> ../../web/dist
const webDist = join(__dirname, '../../web/dist');

export interface BuildAppOptions {
  /** Silence the request logger. Tests pass false to keep output readable. */
  logger?: boolean;
  /**
   * Rate limiting is on in every real deployment. Tests turn it off so that a suite
   * making hundreds of calls — and logging in repeatedly, against a 10/minute cap —
   * does not start failing on throttling rather than on the behaviour under test.
   * The throttle itself is covered by a test that builds an app with it enabled.
   */
  rateLimiting?: boolean;
}

/**
 * Keys the throttle on the account making the request, falling back to the network address
 * for anything unauthenticated.
 *
 * Keying on the address alone is wrong for an internal tool: a station office reaches the
 * internet through one public IP, so a whole shift would share a single 300/minute budget
 * and throttle each other out at about seven requests a minute each. The token is verified
 * rather than merely decoded, so a forged `sub` cannot be used to spend someone else's
 * budget.
 */
export function accountOrAddress(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const claims = request.server.jwt.verify<{ sub: string }>(header.slice(7));
      if (claims.sub) return `account:${claims.sub}`;
    } catch {
      // Not a usable token; fall through and throttle by address like any other stranger.
    }
  }
  return `address:${request.ip}`;
}

/**
 * Builds the fully wired application without binding a socket, so tests can drive it
 * through `app.inject()`. Everything tied to the process lifetime — the SSE heartbeat,
 * signal handlers, listening — belongs to the entrypoint in index.ts, not here.
 */
export async function buildApp({ logger = true, rateLimiting = true }: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger
      ? {
          level: 'info',
          ...(isProd ? {} : { transport: undefined }),
          // Request lines are logged with their URL, and the stream carries its credential
          // in the query string because EventSource cannot set a header. Logging the path
          // without the query keeps that — and anything else a URL picks up — out of the
          // log, at the cost of nothing anyone reads these lines for.
          serializers: {
            req: (request: { method: string; url: string; ip: string }) => ({
              method: request.method,
              url: request.url.split('?')[0],
              remoteAddress: request.ip,
            }),
          },
        }
      : false,
    trustProxy: true,
  });

  // In production the API serves the SPA from its own origin, so nothing cross-origin is
  // expected: default to same-origin rather than reflecting whatever Origin arrives, which
  // with credentials enabled would let any site call the API with a user's session.
  // Development still needs the Vite dev server on :5173 to reach it.
  await app.register(cors, {
    origin: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((o) => o.trim()) : !isProd,
    credentials: true,
  });
  // Registered before the throttle, which verifies bearer tokens to key on the account.
  await app.register(jwt, { secret: env.JWT_SECRET });
  // Left on the default onRequest hook so a flood is turned away before it reaches
  // authentication, rather than after. /login attaches a second, narrower limiter of its
  // own as a preHandler, where the body it keys on has been parsed.
  if (rateLimiting) {
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute', keyGenerator: accountOrAddress });
  }

  // The SPA loads its typeface from Google Fonts; everything else is same-origin, and the
  // event stream is a same-origin connect. `frame-ancestors` keeps the board out of an
  // iframe on someone else's page, where it could be clickjacked into a state change.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (isProd) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  /**
   * Anything that reaches here is a bug rather than a refusal: the routes answer every
   * expected failure themselves with a status and a message. Fastify's default would put
   * `err.message` in the response, which for an unhandled Prisma error means constraint and
   * column names on the wire, so the detail is logged and the caller gets a reference to
   * quote instead. Errors that carry a 4xx of their own — body parsing, the throttle — are
   * answers to the request and pass through as they are.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: error.name, message: error.message });

    const reference = randomUUID().slice(0, 8);
    request.log.error({ err: error, reference }, 'Unhandled error');
    return reply.code(500).send({
      error: 'InternalServerError',
      message: `Something went wrong. Quote reference ${reference} when reporting this.`,
      reference,
    });
  });

  app.get('/api/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', uptime: process.uptime(), sseClients: clientCount(), time: new Date().toISOString() };
  });

  // Server-sent events stream powering the live telemetry board.
  //
  // EventSource cannot set headers, so a browser authorises the stream with a ticket in the
  // query string — deliberately not the session token, which would then be written into
  // every access log along the way and stay valid for its full twelve hours. Tickets last
  // thirty seconds and authorise nothing else. A bearer header still works, for anything
  // that can set one.
  app.get('/api/stream', async (request, reply) => {
    const { ticket } = request.query as { ticket?: string };
    try {
      if (ticket) {
        const claims = app.jwt.verify<StreamTicket>(ticket);
        if (claims.typ !== STREAM_TICKET_TYPE) throw new Error('not a stream ticket');
      } else {
        await request.jwtVerify();
      }
    } catch {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Valid session required' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    addClient(reply);
    return reply;
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(overviewRoutes, { prefix: '/api/overview' });
  await app.register(fleetRoutes, { prefix: '/api/fleet' });
  await app.register(defectRoutes, { prefix: '/api/defects' });
  await app.register(stationRoutes, { prefix: '/api/stations' });
  await app.register(alertRoutes, { prefix: '/api/alerts' });
  await app.register(historyRoutes, { prefix: '/api/history' });
  await app.register(auditRoutes, { prefix: '/api/audit' });

  // Serve the built SPA (production single-service deployment). Must stay last: it owns
  // the catch-all not-found handler that falls back to index.html for client routes.
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'NotFound', message: 'No such endpoint' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`No SPA build found at ${webDist}; serving API only`);
  }

  return app;
}
