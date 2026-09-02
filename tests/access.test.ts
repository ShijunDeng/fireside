import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COLLABORATION_SESSION_TTL_MS,
  createAuthRateLimiter,
  decodeWriteKeyHeader,
  issueCollaborationSession,
  normalizeClientIp,
  requireProductionWriteKey,
  validateCollaborationSession,
  WRITE_KEY_HEADER_ENCODING,
  writeKeyMatches,
} from '../server/access';

describe('围炉口令安全边界', () => {
  it('使用固定长度摘要比较口令', () => {
    assert.equal(writeKeyMatches('same-secret', 'same-secret'), true);
    assert.equal(writeKeyMatches('short', 'a-much-longer-secret'), false);
    assert.equal(writeKeyMatches(undefined, 'secret'), false);
    assert.equal(writeKeyMatches('', 'secret'), false);
  });

  it('生产环境只接受无首尾空白的 6..256 code point 显式配置', () => {
    const valid6 = 'secret';
    const valid256 = Array.from({ length: 256 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('');
    assert.equal(requireProductionWriteKey('production', valid6), valid6);
    assert.equal(requireProductionWriteKey('production', valid256), valid256);
    const validUnicode6 = '🔥'.repeat(5) + '炬';
    assert.equal(requireProductionWriteKey('production', validUnicode6), validUnicode6);
    assert.equal(requireProductionWriteKey('production', '火'.repeat(6)), '火'.repeat(6));
    assert.equal(requireProductionWriteKey('test', 'short'), 'short');
    assert.equal(requireProductionWriteKey('development', undefined), undefined);

    for (const invalid of [
      undefined,
      '',
      '五字符',
      'x'.repeat(5),
      '🔥'.repeat(5),
      `${valid6} `,
      ` ${valid6}`,
      'x'.repeat(257),
      '火'.repeat(257),
    ]) {
      assert.throws(
        () => requireProductionWriteKey('production', invalid),
        (error: Error) => {
          assert.match(error.message, /FIRESIDE_WRITE_KEY/);
          if (invalid) assert.equal(error.message.includes(invalid), false);
          return true;
        },
      );
    }
  });

  it('严格解码版本化 UTF-8 口令并兼容旧 ASCII', () => {
    const candidates = ['松风明月共围炉', 'ASCII-secret', '🔥围炉夜话🔥'];
    for (const candidate of candidates) {
      const encoded = Buffer.from(candidate, 'utf8').toString('base64url');
      assert.equal(decodeWriteKeyHeader(encoded, WRITE_KEY_HEADER_ENCODING), candidate);
    }
    assert.equal(decodeWriteKeyHeader('legacy-ascii', undefined), 'legacy-ascii');
    assert.equal(decodeWriteKeyHeader('围炉', undefined), undefined);
    for (const [value, encoding] of [
      ['', WRITE_KEY_HEADER_ENCODING],
      ['====', WRITE_KEY_HEADER_ENCODING],
      ['YQ==', WRITE_KEY_HEADER_ENCODING],
      ['YQ', 'unknown-v2'],
      [Buffer.from([0xc3, 0x28]).toString('base64url'), WRITE_KEY_HEADER_ENCODING],
      [Buffer.alloc(1025, 0x61).toString('base64url'), WRITE_KEY_HEADER_ENCODING],
    ] as const) {
      assert.equal(decodeWriteKeyHeader(value, encoding), undefined);
    }
  });
});

describe('短期协作会话令牌', () => {
  const baseNow = Date.UTC(2026, 8, 2, 10, 0, 0);
  const writeKey = 'correct-horse-battery-staple-for-fireside';
  const deterministicNonce = (offset = 0) => (_size: number) => (
    Uint8Array.from({ length: 16 }, (_, index) => (index + offset) & 0xff)
  );

  it('签发固定 8 小时、无敏感正文且可确定性校验的 v1 令牌', () => {
    const issued = issueCollaborationSession(writeKey, {
      now: () => baseNow + 987,
      randomBytes: deterministicNonce(),
    });
    assert.match(issued.sessionToken, /^v1\.\d+\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.sessionToken.includes(writeKey), false);
    assert.equal(issued.expiresAt, new Date(Math.floor(baseNow / 1_000) * 1_000 + COLLABORATION_SESSION_TTL_MS).toISOString());
    assert.deepEqual(validateCollaborationSession(issued.sessionToken, writeKey, { now: () => baseNow }), {
      valid: true,
      expiresAt: issued.expiresAt,
    });

    const another = issueCollaborationSession(writeKey, {
      now: () => baseNow,
      randomBytes: deterministicNonce(1),
    });
    assert.notEqual(another.sessionToken, issued.sessionToken);
  });

  it('在精确过期边界失效，不允许续期或超过 60 秒的未来签发', () => {
    const issued = issueCollaborationSession(writeKey, { now: () => baseNow, randomBytes: deterministicNonce() });
    assert.equal(validateCollaborationSession(issued.sessionToken, writeKey, {
      now: () => baseNow + COLLABORATION_SESSION_TTL_MS - 1,
    }).valid, true);
    assert.deepEqual(validateCollaborationSession(issued.sessionToken, writeKey, {
      now: () => baseNow + COLLABORATION_SESSION_TTL_MS,
    }), { valid: false });

    const allowedFuture = issueCollaborationSession(writeKey, {
      now: () => baseNow + 60_000,
      randomBytes: deterministicNonce(2),
    });
    assert.equal(validateCollaborationSession(allowedFuture.sessionToken, writeKey, { now: () => baseNow }).valid, true);
    const rejectedFuture = issueCollaborationSession(writeKey, {
      now: () => baseNow + 61_000,
      randomBytes: deterministicNonce(3),
    });
    assert.deepEqual(validateCollaborationSession(rejectedFuture.sessionToken, writeKey, { now: () => baseNow }), { valid: false });
  });

  it('拒绝逐段篡改、错误长度、非 ASCII、无效时钟和错误随机源', () => {
    const issued = issueCollaborationSession(writeKey, { now: () => baseNow, randomBytes: deterministicNonce() });
    const parts = issued.sessionToken.split('.');
    const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const canonicalLastIndex = base64UrlAlphabet.indexOf(parts[4].at(-1)!);
    const nonCanonicalMac = `${parts[4].slice(0, -1)}${base64UrlAlphabet[canonicalLastIndex + 1]}`;
    const mutations = [
      ['v2', ...parts.slice(1)].join('.'),
      [parts[0], String(Number(parts[1]) + 1), String(Number(parts[2]) + 1), ...parts.slice(3)].join('.'),
      [parts[0], parts[1], String(Number(parts[2]) + 1), ...parts.slice(3)].join('.'),
      [...parts.slice(0, 3), `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`, parts[4]].join('.'),
      [...parts.slice(0, 4), `${parts[4][0] === 'A' ? 'B' : 'A'}${parts[4].slice(1)}`].join('.'),
      [...parts.slice(0, 4), nonCanonicalMac].join('.'),
      `${issued.sessionToken}.extra`,
      'x'.repeat(161),
      `${issued.sessionToken}火`,
    ];
    for (const mutation of mutations) {
      assert.deepEqual(validateCollaborationSession(mutation, writeKey, { now: () => baseNow }), { valid: false });
    }
    assert.deepEqual(validateCollaborationSession(undefined, writeKey, { now: () => baseNow }), { valid: false });
    assert.deepEqual(validateCollaborationSession(issued.sessionToken, writeKey, { now: () => Number.NaN }), { valid: false });
    assert.deepEqual(validateCollaborationSession(issued.sessionToken, writeKey, { now: () => Number.POSITIVE_INFINITY }), { valid: false });
    assert.throws(() => issueCollaborationSession(writeKey, { now: () => Number.NaN }), /时钟/);
    assert.throws(() => issueCollaborationSession(writeKey, {
      now: () => baseNow,
      randomBytes: () => new Uint8Array(15),
    }), /随机源/);
  });

  it('口令轮换立即使旧令牌失效，相同口令重启语义不影响令牌', () => {
    const issued = issueCollaborationSession(writeKey, { now: () => baseNow, randomBytes: deterministicNonce() });
    assert.equal(validateCollaborationSession(issued.sessionToken, writeKey, { now: () => baseNow + 1_000 }).valid, true);
    assert.deepEqual(validateCollaborationSession(issued.sessionToken, `${writeKey}-rotated`, { now: () => baseNow + 1_000 }), { valid: false });
    assert.equal(validateCollaborationSession(issued.sessionToken, writeKey, { now: () => baseNow + 2_000 }).valid, true);
  });

  it('支持 Unix epoch 注入且拒绝超出 Date 表示范围的签发时钟', () => {
    const issued = issueCollaborationSession(writeKey, { now: () => 0, randomBytes: deterministicNonce() });
    assert.equal(validateCollaborationSession(issued.sessionToken, writeKey, { now: () => 0 }).valid, true);
    assert.throws(() => issueCollaborationSession(writeKey, {
      now: () => Number.MAX_VALUE,
      randomBytes: deterministicNonce(),
    }), /时钟/);
  });
});

describe('可信来源 IP 归一化', () => {
  it('把 IPv4-mapped IPv6 与 IPv4 归到同一桶并规范化 IPv6', () => {
    assert.equal(normalizeClientIp('127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeClientIp('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeClientIp('::FFFF:7f00:1'), '127.0.0.1');
    assert.equal(normalizeClientIp('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
    assert.equal(normalizeClientIp('fe80::1%ETH0'), 'fe80::1%eth0');
  });

  it('缺失或非法来源使用共享 unknown 桶而不解析转发列表', () => {
    for (const value of [undefined, null, '', 'not-an-ip', '127.0.0.1, 10.0.0.1', '[::1]']) {
      assert.equal(normalizeClientIp(value), 'unknown');
    }
  });
});

describe('口令验证滑动窗口限流器', () => {
  it('前 N 次失败可记录，下一次预检限流并给出确定性 Retry-After', () => {
    let now = 1_000;
    const limiter = createAuthRateLimiter({ now: () => now, windowMs: 1_000, perSourceLimit: 2, globalLimit: 100 });
    assert.deepEqual(limiter.preflight('source-a'), { limited: false });
    assert.deepEqual(limiter.recordFailure('source-a'), { limited: false });
    assert.deepEqual(limiter.recordFailure('source-a'), { limited: false });
    assert.deepEqual(limiter.preflight('source-a'), { limited: true, retryAfter: 1 });
    assert.deepEqual(limiter.recordFailure('source-a'), { limited: true, retryAfter: 1 });
    assert.deepEqual(limiter.stats(), { sourceCount: 1, globalFailureCount: 2, maxSourceFailureCount: 2 });

    now = 1_999;
    assert.deepEqual(limiter.preflight('source-a'), { limited: true, retryAfter: 1 });
    now = 2_000;
    assert.deepEqual(limiter.preflight('source-a'), { limited: false });
    assert.deepEqual(limiter.stats(), { sourceCount: 0, globalFailureCount: 0, maxSourceFailureCount: 0 });
  });

  it('同步重检容量使 12 个并发失败严格产生 10 个记录与 2 个限流', async () => {
    const limiter = createAuthRateLimiter({ now: () => 10_000, perSourceLimit: 10, globalLimit: 100 });
    const results = await Promise.all(Array.from({ length: 12 }, async () => {
      const gate = limiter.preflight('same-source');
      return gate.limited ? gate : limiter.recordFailure('same-source');
    }));
    assert.equal(results.filter((result) => result.limited).length, 2);
    assert.deepEqual(limiter.stats(), { sourceCount: 1, globalFailureCount: 10, maxSourceFailureCount: 10 });
  });

  it('全局桶跨来源阻断，成功只清来源桶而不清全局历史', () => {
    let now = 5_000;
    const limiter = createAuthRateLimiter({ now: () => now, windowMs: 2_500, perSourceLimit: 10, globalLimit: 3 });
    assert.deepEqual(limiter.recordFailure('a'), { limited: false });
    assert.deepEqual(limiter.recordFailure('a'), { limited: false });
    assert.deepEqual(limiter.recordFailure('b'), { limited: false });
    assert.deepEqual(limiter.preflight('new-source'), { limited: true, retryAfter: 3 });
    limiter.recordSuccess('a');
    assert.deepEqual(limiter.stats(), { sourceCount: 1, globalFailureCount: 3, maxSourceFailureCount: 1 });
    assert.deepEqual(limiter.preflight('a'), { limited: true, retryAfter: 3 });

    now = 7_500;
    assert.deepEqual(limiter.preflight('new-source'), { limited: false });
  });

  it('默认全局容量严格为 200 次实际失败', () => {
    const limiter = createAuthRateLimiter({ now: () => 1_000 });
    for (let index = 0; index < 200; index += 1) {
      assert.deepEqual(limiter.recordFailure(`source-${index}`), { limited: false });
    }
    assert.deepEqual(limiter.preflight('source-200'), { limited: true, retryAfter: 60 });
    assert.deepEqual(limiter.recordFailure('source-200'), { limited: true, retryAfter: 60 });
    assert.equal(limiter.stats().globalFailureCount, 200);
  });

  it('成功清除本来源失败史但不影响其他来源', () => {
    const limiter = createAuthRateLimiter({ now: () => 2_000, perSourceLimit: 1, globalLimit: 100 });
    limiter.recordFailure('a');
    limiter.recordFailure('b');
    limiter.recordSuccess('a');
    assert.deepEqual(limiter.preflight('a'), { limited: false });
    assert.deepEqual(limiter.preflight('b'), { limited: true, retryAfter: 60 });
    assert.equal(limiter.stats().globalFailureCount, 2);
  });

  it('时钟倒退或无效时钳制在最近有效时间，不能提前释放容量', () => {
    let now = 10_000;
    const limiter = createAuthRateLimiter({ now: () => now, windowMs: 10_000, perSourceLimit: 1, globalLimit: 100 });
    limiter.recordFailure('a');
    now = 15_000;
    assert.deepEqual(limiter.preflight('a'), { limited: true, retryAfter: 5 });
    now = 1_000;
    assert.deepEqual(limiter.preflight('a'), { limited: true, retryAfter: 5 });
    now = Number.NaN;
    assert.deepEqual(limiter.preflight('a'), { limited: true, retryAfter: 5 });
  });

  it('以 Map 插入顺序实现确定性 LRU，命中会刷新最近使用', () => {
    const limiter = createAuthRateLimiter({
      now: () => 1_000,
      perSourceLimit: 1,
      globalLimit: 100,
      maxSources: 3,
      cleanupInterval: 100,
    });
    limiter.recordFailure('a');
    limiter.recordFailure('b');
    limiter.recordFailure('c');
    assert.equal(limiter.preflight('a').limited, true);
    limiter.recordFailure('d');
    assert.deepEqual(limiter.preflight('b'), { limited: false });
    assert.equal(limiter.preflight('a').limited, true);
    assert.equal(limiter.preflight('c').limited, true);
    assert.equal(limiter.preflight('d').limited, true);
    assert.equal(limiter.stats().sourceCount, 3);
  });

  it('按固定批次惰性清理过期来源且不突破配置内存上限', () => {
    let now = 0;
    const cleanupLimiter = createAuthRateLimiter({
      now: () => now,
      windowMs: 1_000,
      perSourceLimit: 10,
      globalLimit: 100,
      cleanupInterval: 2,
      cleanupBatchSize: 1,
    });
    cleanupLimiter.recordFailure('expired');
    now = 1_000;
    cleanupLimiter.recordFailure('current');
    assert.deepEqual(cleanupLimiter.stats(), { sourceCount: 1, globalFailureCount: 1, maxSourceFailureCount: 1 });

    now = 0;
    const cursorLimiter = createAuthRateLimiter({
      now: () => now,
      windowMs: 1_000,
      perSourceLimit: 10,
      globalLimit: 100,
      cleanupInterval: 3,
      cleanupBatchSize: 1,
    });
    cursorLimiter.recordFailure('stale-behind-current');
    now = 900;
    cursorLimiter.recordFailure('current-at-front');
    cursorLimiter.preflight('stale-behind-current');
    now = 1_000;
    cursorLimiter.recordFailure('cleanup-trigger');
    assert.deepEqual(cursorLimiter.stats(), { sourceCount: 2, globalFailureCount: 2, maxSourceFailureCount: 1 });

    const bounded = createAuthRateLimiter({
      now: () => 1_000,
      perSourceLimit: 2,
      globalLimit: 20_000,
      maxSources: 10_000,
      cleanupInterval: 20_000,
    });
    for (let index = 0; index < 10_001; index += 1) bounded.recordFailure(`source-${index}`);
    assert.deepEqual(bounded.stats(), { sourceCount: 10_000, globalFailureCount: 10_001, maxSourceFailureCount: 1 });
  });
});
