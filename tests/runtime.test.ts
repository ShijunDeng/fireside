import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  installGracefulShutdown,
  resolveListenTarget,
  type SignalSource,
} from '../server/runtime.js';

describe('生产监听目标', () => {
  const currentPid = 24_680;
  const fallback = {
    HOST: '127.0.0.1',
    PORT: '3100',
  };

  it('仅接受属于当前进程、唯一且命名正确的 systemd fd 3', () => {
    assert.deepEqual(resolveListenTarget({
      ...fallback,
      LISTEN_PID: String(currentPid),
      LISTEN_FDS: '1',
      LISTEN_FDNAMES: 'fireside',
    }, currentPid), {
      kind: 'systemd',
      options: { fd: 3 },
    });
  });

  it('PID、数量或名称任一不匹配均忽略继承 fd 并回退 HOST/PORT', () => {
    const invalidEnvironments = [
      { LISTEN_PID: String(currentPid + 1), LISTEN_FDS: '1', LISTEN_FDNAMES: 'fireside' },
      { LISTEN_PID: `0${currentPid}`, LISTEN_FDS: '1', LISTEN_FDNAMES: 'fireside' },
      { LISTEN_PID: String(currentPid), LISTEN_FDS: '0', LISTEN_FDNAMES: 'fireside' },
      { LISTEN_PID: String(currentPid), LISTEN_FDS: '2', LISTEN_FDNAMES: 'fireside' },
      { LISTEN_PID: String(currentPid), LISTEN_FDS: '01', LISTEN_FDNAMES: 'fireside' },
      { LISTEN_PID: String(currentPid), LISTEN_FDS: '1', LISTEN_FDNAMES: 'other' },
      { LISTEN_PID: String(currentPid), LISTEN_FDS: '1', LISTEN_FDNAMES: 'fireside:other' },
      { LISTEN_PID: String(currentPid), LISTEN_FDS: '1' },
    ];

    for (const inherited of invalidEnvironments) {
      assert.deepEqual(resolveListenTarget({ ...fallback, ...inherited }, currentPid), {
        kind: 'network',
        options: { host: '127.0.0.1', port: 3100 },
      });
    }
  });

  it('普通启动使用安全默认值，并拒绝含糊或越界端口', () => {
    assert.deepEqual(resolveListenTarget({}, currentPid), {
      kind: 'network',
      options: { host: '0.0.0.0', port: 80 },
    });
    assert.deepEqual(resolveListenTarget({ HOST: '', PORT: '0' }, currentPid), {
      kind: 'network',
      options: { host: '0.0.0.0', port: 0 },
    });

    for (const port of ['', '080', '1.5', '-1', '65536', 'Infinity', ' 80']) {
      assert.throws(() => resolveListenTarget({ PORT: port }, currentPid), /PORT/);
    }
  });
});

describe('优雅停止', () => {
  it('SIGTERM/SIGINT 和手动重复触发共享同一个关闭 Promise', async () => {
    const source = new EventEmitter() as SignalSource & EventEmitter;
    let closeCalls = 0;
    let releaseClose!: () => void;
    const closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const seenSignals: string[] = [];
    const controller = installGracefulShutdown({
      source,
      close: async () => {
        closeCalls += 1;
        await closeBarrier;
      },
      onSignal: (signal) => seenSignals.push(signal),
    });

    source.emit('SIGTERM');
    source.emit('SIGINT');
    const first = controller.shutdown('SIGINT');
    const second = controller.shutdown();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(closeCalls, 1);
    assert.deepEqual(seenSignals, ['SIGTERM']);

    releaseClose();
    await first;
    await controller.shutdown('SIGTERM');
    assert.equal(closeCalls, 1);
    controller.dispose();
  });

  it('关闭失败只报告一次且不会产生未处理的重复关闭', async () => {
    const source = new EventEmitter() as SignalSource & EventEmitter;
    const expected = new Error('close failed');
    const errors: unknown[] = [];
    let closeCalls = 0;
    const controller = installGracefulShutdown({
      source,
      close: async () => {
        closeCalls += 1;
        throw expected;
      },
      onError: (error) => errors.push(error),
    });

    source.emit('SIGINT');
    source.emit('SIGTERM');
    await assert.rejects(controller.shutdown(), expected);
    assert.equal(closeCalls, 1);
    assert.deepEqual(errors, [expected]);
    controller.dispose();
    source.emit('SIGTERM');
    assert.equal(closeCalls, 1);
  });
});
