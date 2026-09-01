export const SYSTEMD_LISTEN_FD = 3;
export const SYSTEMD_SOCKET_NAME = 'fireside';

type RuntimeEnvironment = Record<string, string | undefined>;

export type ListenTarget =
  | {
    kind: 'systemd';
    options: { fd: typeof SYSTEMD_LISTEN_FD };
  }
  | {
    kind: 'network';
    options: { host: string; port: number };
  };

function parsePort(value: string | undefined): number {
  const candidate = value ?? '80';
  if (!/^(?:0|[1-9]\d{0,4})$/.test(candidate)) {
    throw new Error('PORT 必须是 0 到 65535 之间的十进制整数');
  }
  const port = Number(candidate);
  if (port > 65_535) {
    throw new Error('PORT 必须是 0 到 65535 之间的十进制整数');
  }
  return port;
}

export function resolveListenTarget(
  environment: RuntimeEnvironment,
  currentPid: number,
): ListenTarget {
  const validPid = Number.isSafeInteger(currentPid) && currentPid > 0;
  const hasSingleNamedSystemdSocket = validPid
    && environment.LISTEN_PID === String(currentPid)
    && environment.LISTEN_FDS === '1'
    && environment.LISTEN_FDNAMES === SYSTEMD_SOCKET_NAME;

  if (hasSingleNamedSystemdSocket) {
    return { kind: 'systemd', options: { fd: SYSTEMD_LISTEN_FD } };
  }

  return {
    kind: 'network',
    options: {
      host: environment.HOST || '0.0.0.0',
      port: parsePort(environment.PORT),
    },
  };
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export type SignalSource = {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
};

type GracefulShutdownOptions = {
  source: SignalSource;
  close: () => Promise<void>;
  onSignal?: (signal: ShutdownSignal) => void;
  onError?: (error: unknown) => void;
};

export type GracefulShutdown = {
  shutdown(signal?: ShutdownSignal): Promise<void>;
  dispose(): void;
};

export function installGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal?: ShutdownSignal): Promise<void> => {
    if (!shutdownPromise) {
      if (signal) options.onSignal?.(signal);
      shutdownPromise = Promise.resolve()
        .then(options.close)
        .catch((error: unknown) => {
          options.onError?.(error);
          throw error;
        });
    }
    return shutdownPromise;
  };

  const handleSigterm = () => {
    void shutdown('SIGTERM').catch(() => undefined);
  };
  const handleSigint = () => {
    void shutdown('SIGINT').catch(() => undefined);
  };

  options.source.on('SIGTERM', handleSigterm);
  options.source.on('SIGINT', handleSigint);

  let disposed = false;
  return {
    shutdown,
    dispose() {
      if (disposed) return;
      disposed = true;
      options.source.off('SIGTERM', handleSigterm);
      options.source.off('SIGINT', handleSigint);
    },
  };
}
