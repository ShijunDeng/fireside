import { createHash, timingSafeEqual } from 'node:crypto';

export function writeKeyMatches(candidate: string | undefined, expected: string) {
  if (!candidate) return false;
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

export function requireProductionWriteKey(nodeEnv: string | undefined, writeKey: string | undefined) {
  if (nodeEnv === 'production' && !writeKey) throw new Error('生产环境必须配置 FIRESIDE_WRITE_KEY');
  return writeKey;
}
