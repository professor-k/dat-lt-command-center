import { env } from './env.js';
import { prisma } from './db.js';
import { heartbeat } from './events.js';
import { buildApp } from './app.js';

const app = await buildApp();

// Keeps idle SSE connections from being dropped by proxies. Lives here rather than in
// buildApp so that tests building an app do not leak a timer.
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
