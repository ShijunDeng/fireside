import { stat } from 'node:fs/promises';
import { buildApp } from './app.js';
import { readDatabaseFingerprint, type DatabaseFingerprint } from './backup.js';

type StableBusinessFingerprint = Pick<DatabaseFingerprint,
  'topicCount'
  | 'participantCount'
  | 'orderVersion'
  | 'revisionsSha256'
  | 'sensitivePresenceSha256'
  | 'businessDataSha256'
>;

function stableBusinessFingerprint(fingerprint: DatabaseFingerprint): StableBusinessFingerprint {
  return {
    topicCount: fingerprint.topicCount,
    participantCount: fingerprint.participantCount,
    orderVersion: fingerprint.orderVersion,
    revisionsSha256: fingerprint.revisionsSha256,
    sensitivePresenceSha256: fingerprint.sensitivePresenceSha256,
    businessDataSha256: fingerprint.businessDataSha256,
  };
}

async function existingFingerprint(databasePath: string) {
  try {
    const info = await stat(databasePath);
    return info.isFile() && info.size > 0
      ? stableBusinessFingerprint(readDatabaseFingerprint(databasePath))
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError('Preflight CLI accepts configuration through environment variables only');
  const databasePath = process.env.DATABASE_PATH;
  const writeKey = process.env.FIRESIDE_WRITE_KEY;
  if (!databasePath) throw new TypeError('DATABASE_PATH is required');
  if (!writeKey) throw new TypeError('FIRESIDE_WRITE_KEY is required');

  const before = await existingFingerprint(databasePath);
  const app = buildApp({ databasePath, seed: false, writeKey, serveStatic: true });
  try {
    await app.ready();
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    if (health.statusCode !== 200 || health.json().ok !== true) throw new Error('Health preflight failed');
    const topics = await app.inject({ method: 'GET', url: '/api/topics' });
    if (topics.statusCode !== 200 || !Array.isArray(topics.json())) throw new Error('Topic preflight failed');
  } finally {
    await app.close();
  }

  const after = stableBusinessFingerprint(readDatabaseFingerprint(databasePath));
  if (before && JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('Candidate migration changed protected business fingerprints');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    topicCount: after.topicCount,
    participantCount: after.participantCount,
    orderVersion: after.orderVersion,
  })}\n`);
}

try {
  await main();
} catch {
  process.stderr.write(`${JSON.stringify({ ok: false, error: 'preflight_failed' })}\n`);
  process.exitCode = 1;
}
