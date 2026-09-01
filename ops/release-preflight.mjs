import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const BUSINESS_TABLES = [
  ['topics', ['id', 'position', 'revision', 'title', 'summary', 'proposer', 'presenter', 'tags', 'status', 'scheduled_at', 'duration', 'room', 'meeting_url', 'takeaway', 'material_url', 'created_at', 'updated_at', 'archived_at']],
  ['topic_participants', ['id', 'topic_id', 'name', 'normalized_name', 'created_at']],
  ['topic_order_state', ['id', 'version']],
];

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function encodeBusinessValue(value) {
  if (value === null) return ['null'];
  if (Buffer.isBuffer(value)) return ['blob', value.toString('base64')];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  return ['text', value];
}

function readBusinessDataSha256(releasePath, databasePath) {
  const requireFromRelease = createRequire(pathToFileURL(`${releasePath}/package.json`));
  const imported = requireFromRelease('better-sqlite3');
  const Database = imported.default ?? imported;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    const hash = createHash('sha256');
    for (const [table, columns] of BUSINESS_TABLES) {
      hash.update(JSON.stringify({ table, columns }));
      hash.update('\n');
      const selected = columns.map(quoteIdentifier).join(', ');
      const rows = database.prepare(`SELECT ${selected} FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier('id')} ASC`).raw().iterate();
      for (const row of rows) {
        hash.update(JSON.stringify(row.map(encodeBusinessValue)));
        hash.update('\n');
      }
    }
    return hash.digest('hex');
  } finally {
    database.close();
  }
}

function stableBusinessFingerprint(releasePath, databasePath, fingerprint) {
  return {
    topicCount: fingerprint.topicCount,
    participantCount: fingerprint.participantCount,
    orderVersion: fingerprint.orderVersion,
    revisionsSha256: fingerprint.revisionsSha256,
    sensitivePresenceSha256: fingerprint.sensitivePresenceSha256,
    businessDataSha256: readBusinessDataSha256(releasePath, databasePath),
  };
}

function existingStableBusinessFingerprint(releasePath, databasePath, backupModule) {
  try {
    const info = statSync(databasePath);
    if (!info.isFile() || info.size === 0) return null;
    return stableBusinessFingerprint(
      releasePath,
      databasePath,
      backupModule.readDatabaseFingerprint(databasePath),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError('Release preflight only accepts a clean environment');
  const releasePath = process.env.FIRESIDE_PREFLIGHT_RELEASE;
  const databasePath = process.env.DATABASE_PATH;
  const writeKey = process.env.FIRESIDE_WRITE_KEY;
  const mode = process.env.FIRESIDE_PREFLIGHT_MODE ?? 'verify';
  if (!releasePath || !databasePath || !writeKey) throw new TypeError('Release preflight environment is incomplete');
  if (mode !== 'verify' && mode !== 'migrate') throw new TypeError('Release preflight mode is invalid');

  const appModule = await import(pathToFileURL(`${releasePath}/server-build/server/app.js`).href);
  const backupModule = await import(pathToFileURL(`${releasePath}/server-build/server/backup.js`).href);
  if (typeof appModule.buildApp !== 'function' || typeof backupModule.readDatabaseFingerprint !== 'function') {
    throw new TypeError('Release does not expose the required preflight boundary');
  }

  const before = existingStableBusinessFingerprint(releasePath, databasePath, backupModule);
  const app = appModule.buildApp({ databasePath, seed: false, writeKey, serveStatic: true });
  try {
    await app.ready();
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    if (health.statusCode !== 200 || health.json().ok !== true) throw new Error('Health preflight failed');
    const topics = await app.inject({ method: 'GET', url: '/api/topics' });
    if (topics.statusCode !== 200 || !Array.isArray(topics.json())) throw new Error('Topic preflight failed');
  } finally {
    await app.close();
  }

  const after = stableBusinessFingerprint(
    releasePath,
    databasePath,
    backupModule.readDatabaseFingerprint(databasePath),
  );
  if (before && JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('Release preflight changed protected business fingerprints');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    topicCount: after.topicCount,
    participantCount: after.participantCount,
    orderVersion: after.orderVersion,
    revisionsSha256: after.revisionsSha256,
    sensitivePresenceSha256: after.sensitivePresenceSha256,
    businessDataSha256: after.businessDataSha256,
  })}\n`);
}

try {
  await main();
} catch {
  process.stderr.write(`${JSON.stringify({ ok: false, error: 'release_preflight_failed' })}\n`);
  process.exitCode = 1;
}
