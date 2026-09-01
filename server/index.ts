import { buildApp } from './app.js';
import { requireProductionWriteKey } from './access.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 80);
const writeKey = requireProductionWriteKey(process.env.NODE_ENV, process.env.FIRESIDE_WRITE_KEY);
const testRateLimit = process.env.NODE_ENV === 'test' ? {
  windowMs: Number(process.env.FIRESIDE_AUTH_RATE_WINDOW_MS ?? 60_000),
  perSourceLimit: Number(process.env.FIRESIDE_AUTH_PER_SOURCE_LIMIT ?? 10),
  globalLimit: Number(process.env.FIRESIDE_AUTH_GLOBAL_LIMIT ?? 200),
} : undefined;
const app = buildApp({ logger: true, writeKey, authRateLimit: testRateLimit });

try {
  await app.listen({ host, port });
  app.log.info(`围炉夜话已点燃：http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
