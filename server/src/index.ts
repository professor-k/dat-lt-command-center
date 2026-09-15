import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import { env, isProd } from './env.js';
import { prisma } from './db.js';
import { addClient, heartbeat, clientCount } from './events.js';
import { authRoutes } from './routes/auth.routes.js';
import { fleetRoutes } from './routes/fleet.routes.js';
import { defectRoutes } from './routes/defects.routes.js';
import { stationRoutes } from './routes/stations.routes.js';
import { alertRoutes } from './routes/alerts.routes.js';
import { overviewRoutes } from './routes/overview.routes.js';
import { historyRoutes } from './routes/history.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/index.js -> ../../web/dist
const webDist = join(__dirname, '../../web/dist');

const app = Fastify({
  logger: isProd
    ? { level: 'info' }
    : { level: 'info', transport: undefined },
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
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
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

// Serve the built SPA (production single-service deployment).
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

const ping = setInterval(heartbeat, 25_000);

async function shutdown(signal: string) {
  app.log.info(`${signal} received, shutting down`);
  clearInterval(ping);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`DAT LT Command Center API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
