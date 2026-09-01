import { buildApp } from './app.js';
import { requireProductionWriteKey } from './access.js';
import { installGracefulShutdown, resolveListenTarget } from './runtime.js';
import type { FastifyListenOptions } from 'fastify';

const writeKey = requireProductionWriteKey(process.env.NODE_ENV, process.env.FIRESIDE_WRITE_KEY);
const testRateLimit = process.env.NODE_ENV === 'test' ? {
  windowMs: Number(process.env.FIRESIDE_AUTH_RATE_WINDOW_MS ?? 60_000),
  perSourceLimit: Number(process.env.FIRESIDE_AUTH_PER_SOURCE_LIMIT ?? 10),
  globalLimit: Number(process.env.FIRESIDE_AUTH_GLOBAL_LIMIT ?? 200),
} : undefined;
const listenTarget = resolveListenTarget(process.env, process.pid);
const app = buildApp({ logger: true, writeKey, authRateLimit: testRateLimit });

try {
  // Fastify forwards listen options to Node's server. Its public type omits the
  // systemd-compatible `fd` variant even though Node accepts it at runtime.
  await app.listen(listenTarget.options as FastifyListenOptions);
  if (listenTarget.kind === 'systemd') {
    app.log.info('围炉夜话已通过 systemd socket fd 3 点燃');
  } else {
    app.log.info(`围炉夜话已点燃：http://${listenTarget.options.host}:${listenTarget.options.port}`);
  }

  installGracefulShutdown({
    source: process,
    close: () => app.close(),
    onSignal: (signal) => app.log.info({ signal }, '正在熄灭炉火并等待在途请求完成'),
    onError: (error) => {
      app.log.error(error, '优雅停止失败');
      process.exitCode = 1;
    },
  });
} catch (error) {
  app.log.error(error);
  try {
    await app.close();
  } catch (closeError) {
    app.log.error(closeError, '启动失败后的资源释放失败');
  }
  process.exitCode = 1;
}
