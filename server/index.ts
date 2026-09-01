import { buildApp } from './app.js';
import { requireProductionWriteKey } from './access.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 80);
const writeKey = requireProductionWriteKey(process.env.NODE_ENV, process.env.FIRESIDE_WRITE_KEY);
const app = buildApp({ logger: true, writeKey });

try {
  await app.listen({ host, port });
  app.log.info(`围炉夜话已点燃：http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
