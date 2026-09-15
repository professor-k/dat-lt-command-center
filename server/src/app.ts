import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import { env, isProd } from './env.js';
import { prisma } from './db.js';
import { addClient, clientCount } from './events.js';
import { authRoutes } from './routes/auth.routes.js';
import { fleetRoutes } from './routes/fleet.routes.js';
import { defectRoutes } from './routes/defects.routes.js';
import { stationRoutes } from './routes/stations.routes.js';
import { alertRoutes } from './routes/alerts.routes.js';
import { overviewRoutes } from './routes/overview.routes.js';
import { historyRoutes } from './routes/history.routes.js';

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
 * Builds the fully wired application without binding a socket, so tests can drive it
 * through `app.inject()`. Everything tied to the process lifetime — the SSE heartbeat,
 * signal handlers, listening — belongs to the entrypoint in index.ts, not here.
 */
export async function buildApp({ logger = true, rateLimiting = true }: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? (isProd ? { level: 'info' } : { level: 'info', transport: undefined }) : false,
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
  if (rateLimiting) await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(jwt, { secret: env.JWT_SECRET });

  app.get('/api/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', uptime: process.uptime(), sseClients: clientCount(), time: new Date().toISOString() };
  });

  // Server-sent events stream powering the live telemetry board.
  // EventSource cannot set headers, so the token may also arrive as a query param.
  app.get('/api/stream', async (request, reply) => {
    const queryToken = (request.query as { token?: string }).token;
    try {
      if (queryToken) app.jwt.verify(queryToken);
      else await request.jwtVerify();
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
