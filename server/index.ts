import { buildApp } from './app.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 80);
const app = buildApp({ logger: true });

try {
  await app.listen({ host, port });
  app.log.info(`围炉夜话已点燃：http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
