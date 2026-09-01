import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';

export const COLLABORATION_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

const SESSION_VERSION = 'v1';
const SESSION_NONCE_BYTES = 16;
const SESSION_MAC_BYTES = 32;
const SESSION_MAX_LENGTH = 160;
const SESSION_FUTURE_SKEW_MS = 60_000;
const SESSION_HKDF_SALT = Buffer.from('fireside-auth-v1', 'utf8');
const SESSION_HKDF_INFO = Buffer.from('collaboration-session-signing-v1', 'utf8');
const SESSION_PATTERN = /^v1\.(0|[1-9]\d{0,12})\.([1-9]\d{0,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_PER_SOURCE_LIMIT = 10;
const DEFAULT_GLOBAL_LIMIT = 200;
const DEFAULT_MAX_SOURCES = 10_000;
const DEFAULT_CLEANUP_INTERVAL = 256;
const DEFAULT_CLEANUP_BATCH_SIZE = 256;

const placeholderWriteKeys = new Set([
  'change-me',
  'changeme',
  'password',
  'fireside',
  'secret',
  'your-key-here',
]);

export function writeKeyMatches(candidate: string | undefined, expected: string) {
  if (!candidate) return false;
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

export function requireProductionWriteKey(nodeEnv: string | undefined, writeKey: string | undefined) {
  if (nodeEnv !== 'production') return writeKey;

  const characters = writeKey ? [...writeKey] : [];
  const valid = Boolean(writeKey)
    && writeKey === writeKey!.trim()
    && characters.length >= 32
    && characters.length <= 256
    && !placeholderWriteKeys.has(writeKey!.toLocaleLowerCase('en-US'))
    && !characters.every((character) => character === characters[0]);

  if (!valid) {
    throw new Error('生产环境 FIRESIDE_WRITE_KEY 必须是无首尾空白的 32 至 256 字符高强度随机值');
  }
  return writeKey;
}

type SessionClockOptions = {
  now?: () => number;
};

export type IssueCollaborationSessionOptions = SessionClockOptions & {
  randomBytes?: (size: number) => Uint8Array;
};

export type IssuedCollaborationSession = {
  sessionToken: string;
  expiresAt: string;
};

export type CollaborationSessionValidation =
  | { valid: true; expiresAt: string }
  | { valid: false };

function readClock(now: (() => number) | undefined) {
  const value = now?.() ?? Date.now();
  if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000 - COLLABORATION_SESSION_TTL_MS) {
    throw new Error('认证时钟不可用');
  }
  return value;
}

function deriveSessionSigningKey(writeKey: string) {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(writeKey, 'utf8'),
    SESSION_HKDF_SALT,
    SESSION_HKDF_INFO,
    SESSION_MAC_BYTES,
  ));
}

function signSessionPayload(payload: string, writeKey: string) {
  return createHmac('sha256', deriveSessionSigningKey(writeKey)).update(payload, 'ascii').digest();
}

export function issueCollaborationSession(
  writeKey: string,
  options: IssueCollaborationSessionOptions = {},
): IssuedCollaborationSession {
  const issuedAtSeconds = Math.floor(readClock(options.now) / 1_000);
  const expiresAtSeconds = issuedAtSeconds + COLLABORATION_SESSION_TTL_MS / 1_000;
  const nonceBytes = Buffer.from((options.randomBytes ?? nodeRandomBytes)(SESSION_NONCE_BYTES));
  if (nonceBytes.length !== SESSION_NONCE_BYTES) throw new Error('会话随机源不可用');

  const nonce = nonceBytes.toString('base64url');
  const payload = `${SESSION_VERSION}.${issuedAtSeconds}.${expiresAtSeconds}.${nonce}`;
  const mac = signSessionPayload(payload, writeKey).toString('base64url');
  return {
    sessionToken: `${payload}.${mac}`,
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
  };
}

export function validateCollaborationSession(
  sessionToken: string | undefined,
  writeKey: string,
  options: SessionClockOptions = {},
): CollaborationSessionValidation {
  if (!sessionToken || sessionToken.length > SESSION_MAX_LENGTH || !/^[\x20-\x7e]+$/.test(sessionToken)) {
    return { valid: false };
  }

  const match = SESSION_PATTERN.exec(sessionToken);
  if (!match) return { valid: false };
  const [, issuedAtText, expiresAtText, nonce, suppliedMacText] = match;
  const issuedAtSeconds = Number(issuedAtText);
  const expiresAtSeconds = Number(expiresAtText);
  if (!Number.isSafeInteger(issuedAtSeconds) || !Number.isSafeInteger(expiresAtSeconds)) return { valid: false };
  if (expiresAtSeconds - issuedAtSeconds !== COLLABORATION_SESSION_TTL_MS / 1_000) return { valid: false };

  const payload = `${SESSION_VERSION}.${issuedAtText}.${expiresAtText}.${nonce}`;
  const expectedMac = signSessionPayload(payload, writeKey);
  const suppliedMac = Buffer.from(suppliedMacText, 'base64url');
  if (
    suppliedMac.length !== SESSION_MAC_BYTES
    || suppliedMac.toString('base64url') !== suppliedMacText
    || !timingSafeEqual(suppliedMac, expectedMac)
  ) return { valid: false };

  let nowMs: number;
  try {
    nowMs = readClock(options.now);
  } catch {
    return { valid: false };
  }
  if (issuedAtSeconds * 1_000 > nowMs + SESSION_FUTURE_SKEW_MS) return { valid: false };
  if (expiresAtSeconds * 1_000 <= nowMs) return { valid: false };
  return { valid: true, expiresAt: new Date(expiresAtSeconds * 1_000).toISOString() };
}

function canonicalIpv6(value: string) {
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function mappedIpv4(value: string) {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (!match) return null;
  const upper = Number.parseInt(match[1], 16);
  const lower = Number.parseInt(match[2], 16);
  return `${upper >>> 8}.${upper & 0xff}.${lower >>> 8}.${lower & 0xff}`;
}

export function normalizeClientIp(value: string | null | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return 'unknown';
  const zoneAt = candidate.indexOf('%');
  const address = zoneAt === -1 ? candidate : candidate.slice(0, zoneAt);
  const zone = zoneAt === -1 ? '' : candidate.slice(zoneAt + 1).toLowerCase();
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6 || (zoneAt !== -1 && !zone)) return 'unknown';
  const canonical = canonicalIpv6(address);
  const mapped = mappedIpv4(canonical);
  if (mapped) return mapped;
  return zone ? `${canonical}%${zone}` : canonical;
}

export type AuthRateLimiterOptions = {
  now?: () => number;
  windowMs?: number;
  perSourceLimit?: number;
  globalLimit?: number;
  maxSources?: number;
  cleanupInterval?: number;
  cleanupBatchSize?: number;
};

export type AuthRateLimitDecision =
  | { limited: false }
  | { limited: true; retryAfter: number };

export type AuthRateLimiterStats = {
  sourceCount: number;
  globalFailureCount: number;
  maxSourceFailureCount: number;
};

export type AuthRateLimiter = {
  preflight: (source: string) => AuthRateLimitDecision;
  recordFailure: (source: string) => AuthRateLimitDecision;
  recordSuccess: (source: string) => void;
  stats: () => AuthRateLimiterStats;
};

type SourceFailures = {
  timestamps: number[];
};

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

export function createAuthRateLimiter(options: AuthRateLimiterOptions = {}): AuthRateLimiter {
  const windowMs = positiveInteger(options.windowMs, DEFAULT_RATE_WINDOW_MS);
  const perSourceLimit = positiveInteger(options.perSourceLimit, DEFAULT_PER_SOURCE_LIMIT);
  const globalLimit = positiveInteger(options.globalLimit, DEFAULT_GLOBAL_LIMIT);
  const maxSources = positiveInteger(options.maxSources, DEFAULT_MAX_SOURCES);
  const cleanupInterval = positiveInteger(options.cleanupInterval, DEFAULT_CLEANUP_INTERVAL);
  const cleanupBatchSize = positiveInteger(options.cleanupBatchSize, DEFAULT_CLEANUP_BATCH_SIZE);
  const sources = new Map<string, SourceFailures>();
  let globalTimestamps: number[] = [];
  let logicalNow = 0;
  let recordedFailures = 0;

  const now = () => {
    const candidate = options.now?.() ?? Date.now();
    if (Number.isFinite(candidate) && candidate >= logicalNow) logicalNow = candidate;
    return logicalNow;
  };
  const removeExpired = (timestamps: number[], currentTime: number) => {
    const firstCurrent = timestamps.findIndex((timestamp) => timestamp > currentTime - windowMs);
    if (firstCurrent === -1) return [];
    return firstCurrent === 0 ? timestamps : timestamps.slice(firstCurrent);
  };
  const touch = (source: string, entry: SourceFailures) => {
    sources.delete(source);
    sources.set(source, entry);
  };
  const cleanSource = (source: string, currentTime: number) => {
    const entry = sources.get(source);
    if (!entry) return undefined;
    entry.timestamps = removeExpired(entry.timestamps, currentTime);
    if (entry.timestamps.length === 0) {
      sources.delete(source);
      return undefined;
    }
    touch(source, entry);
    return entry;
  };
  const cleanupExpiredBatch = (currentTime: number) => {
    let checks = 0;
    const retainedKeys: string[] = [];
    for (const [key, entry] of sources) {
      if (checks >= cleanupBatchSize) break;
      checks += 1;
      entry.timestamps = removeExpired(entry.timestamps, currentTime);
      if (entry.timestamps.length === 0) sources.delete(key);
      else retainedKeys.push(key);
    }
    retainedKeys.forEach((key) => {
      const entry = sources.get(key);
      if (entry) touch(key, entry);
    });
  };
  const evictLeastRecentlyUsed = () => {
    const oldestKey = sources.keys().next().value as string | undefined;
    if (oldestKey !== undefined) sources.delete(oldestKey);
  };
  const prepare = (source: string) => {
    const currentTime = now();
    globalTimestamps = removeExpired(globalTimestamps, currentTime);
    const sourceEntry = cleanSource(source, currentTime);
    return { currentTime, sourceEntry };
  };
  const retryAfter = (timestamps: number[], currentTime: number) => Math.max(
    1,
    Math.min(Math.ceil(windowMs / 1_000), Math.ceil((timestamps[0] + windowMs - currentTime) / 1_000)),
  );
  const decision = (sourceEntry: SourceFailures | undefined, currentTime: number): AuthRateLimitDecision => {
    const waits: number[] = [];
    if (sourceEntry && sourceEntry.timestamps.length >= perSourceLimit) {
      waits.push(retryAfter(sourceEntry.timestamps, currentTime));
    }
    if (globalTimestamps.length >= globalLimit) waits.push(retryAfter(globalTimestamps, currentTime));
    return waits.length === 0 ? { limited: false } : { limited: true, retryAfter: Math.max(...waits) };
  };

  return {
    preflight(source) {
      const prepared = prepare(source);
      return decision(prepared.sourceEntry, prepared.currentTime);
    },
    recordFailure(source) {
      const prepared = prepare(source);
      const currentDecision = decision(prepared.sourceEntry, prepared.currentTime);
      if (currentDecision.limited) return currentDecision;

      let entry = prepared.sourceEntry;
      if (!entry) {
        if (sources.size >= maxSources) evictLeastRecentlyUsed();
        entry = { timestamps: [] };
        sources.set(source, entry);
      }
      entry.timestamps.push(prepared.currentTime);
      touch(source, entry);
      globalTimestamps.push(prepared.currentTime);
      recordedFailures += 1;
      if (recordedFailures % cleanupInterval === 0) cleanupExpiredBatch(prepared.currentTime);
      return { limited: false };
    },
    recordSuccess(source) {
      const currentTime = now();
      globalTimestamps = removeExpired(globalTimestamps, currentTime);
      sources.delete(source);
    },
    stats() {
      const currentTime = now();
      globalTimestamps = removeExpired(globalTimestamps, currentTime);
      cleanupExpiredBatch(currentTime);
      let maxSourceFailureCount = 0;
      for (const entry of sources.values()) maxSourceFailureCount = Math.max(maxSourceFailureCount, entry.timestamps.length);
      return { sourceCount: sources.size, globalFailureCount: globalTimestamps.length, maxSourceFailureCount };
    },
  };
}
