import Database from 'better-sqlite3';
import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  open,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_RETENTION = 14;
const BACKUP_NAME = /^fireside-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-([a-f0-9]{16})\.sqlite3$/;

export type DatabaseFingerprint = {
  integrityCheck: 'ok';
  topicCount: number;
  participantCount: number;
  orderVersion: number;
  revisionsSha256: string;
  sensitivePresenceSha256: string;
  contentSha256: string;
};

export type BackupMetadata = {
  createdAt: string;
  filename: string;
  bytes: number;
  sha256: string;
  topicCount: number;
  participantCount: number;
  orderVersion: number;
  retainedBackups: number;
  prunedBackups: number;
  retentionErrors: number;
};

export type CreateBackupOptions = {
  sourcePath: string;
  backupDirectory: string;
  retention?: number;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
};

type SqliteValue = null | number | bigint | string | Buffer;
type SqliteRow = Record<string, SqliteValue>;

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function encodeValue(value: SqliteValue) {
  if (value === null) return ['null'];
  if (Buffer.isBuffer(value)) return ['blob', value.toString('base64')];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  return ['text', value];
}

function updateRowHash(hash: ReturnType<typeof createHash>, columns: string[], row: SqliteRow) {
  hash.update(JSON.stringify(columns.map((column) => encodeValue(row[column]))));
  hash.update('\n');
}

function contentFingerprint(db: Database.Database) {
  const hash = createHash('sha256');
  const tables = db.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'table' AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')
    ORDER BY name ASC
  `).all() as { name: string; sql: string | null }[];

  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as {
      name: string;
      pk: number;
    }[];
    const columnNames = columns.map(({ name }) => name);
    const primaryKey = columns.filter(({ pk }) => pk > 0).sort((a, b) => a.pk - b.pk).map(({ name }) => name);
    const orderBy = primaryKey.length
      ? primaryKey.map(quoteIdentifier).join(', ')
      : 'rowid';
    hash.update(JSON.stringify({ table: table.name, sql: table.sql, columns: columnNames }));
    hash.update('\n');
    const statement = db.prepare(`SELECT * FROM ${quoteIdentifier(table.name)} ORDER BY ${orderBy}`);
    for (const row of statement.iterate() as IterableIterator<SqliteRow>) {
      updateRowHash(hash, columnNames, row);
    }
  }

  return hash.digest('hex');
}

function inspectOpenDatabase(db: Database.Database): DatabaseFingerprint {
  db.pragma('query_only = ON');
  const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('SQLite backup integrity check failed');
  }

  const topicCount = Number((db.prepare('SELECT COUNT(*) AS count FROM topics').get() as { count: number | bigint }).count);
  const participantCount = Number((db.prepare('SELECT COUNT(*) AS count FROM topic_participants').get() as { count: number | bigint }).count);
  const orderVersion = Number((db.prepare('SELECT version FROM topic_order_state WHERE id = 1').get() as { version: number | bigint } | undefined)?.version ?? 0);

  const revisions = createHash('sha256');
  for (const row of db.prepare('SELECT id, revision FROM topics ORDER BY id ASC').iterate() as IterableIterator<{ id: number | bigint; revision: number | bigint }>) {
    revisions.update(`${row.id}:${row.revision}\n`);
  }

  const sensitivePresence = createHash('sha256');
  for (const row of db.prepare(`
    SELECT id,
      CASE WHEN room IS NOT NULL AND room <> '' THEN 1 ELSE 0 END AS has_room,
      CASE WHEN meeting_url IS NOT NULL AND meeting_url <> '' THEN 1 ELSE 0 END AS has_meeting_url,
      CASE WHEN takeaway IS NOT NULL AND takeaway <> '' THEN 1 ELSE 0 END AS has_takeaway,
      CASE WHEN material_url IS NOT NULL AND material_url <> '' THEN 1 ELSE 0 END AS has_material_url
    FROM topics ORDER BY id ASC
  `).iterate() as IterableIterator<Record<string, number | bigint>>) {
    sensitivePresence.update(`${row.id}:${row.has_room}:${row.has_meeting_url}:${row.has_takeaway}:${row.has_material_url}\n`);
  }
  for (const row of db.prepare(`
    SELECT topic_id, COUNT(*) AS participant_count,
      SUM(CASE WHEN name <> '' THEN 1 ELSE 0 END) AS named_count
    FROM topic_participants GROUP BY topic_id ORDER BY topic_id ASC
  `).iterate() as IterableIterator<Record<string, number | bigint>>) {
    sensitivePresence.update(`${row.topic_id}:${row.participant_count}:${row.named_count}\n`);
  }

  return {
    integrityCheck: 'ok',
    topicCount,
    participantCount,
    orderVersion,
    revisionsSha256: revisions.digest('hex'),
    sensitivePresenceSha256: sensitivePresence.digest('hex'),
    contentSha256: contentFingerprint(db),
  };
}

export function readDatabaseFingerprint(databasePath: string) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return inspectOpenDatabase(db);
  } finally {
    db.close();
  }
}

function formatTimestamp(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new TypeError('Backup clock must return a valid Date');
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '');
}

function backupNameTimestamp(filename: string) {
  const match = BACKUP_NAME.exec(filename);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== iso) return null;
  return timestamp;
}

export function isBackupFilename(filename: string) {
  return backupNameTimestamp(filename) !== null;
}

async function sha256File(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function requireBackupDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('Backup destination must be a real directory');
}

async function requireAbsent(filename: string) {
  try {
    await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Generated backup destination already exists');
}

async function pruneBackups(directory: string, retention: number, publishedFilename: string) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { retainedBackups: 1, prunedBackups: 0, retentionErrors: 1 };
  }
  const matching = entries
    .filter((entry) => entry.isFile() && isBackupFilename(entry.name))
    .map((entry) => ({ name: entry.name, timestamp: backupNameTimestamp(entry.name)! }))
    .sort((a, b) => b.timestamp - a.timestamp || b.name.localeCompare(a.name));
  const retainedNames = new Set([
    publishedFilename,
    ...matching
      .filter(({ name }) => name !== publishedFilename)
      .slice(0, retention - 1)
      .map(({ name }) => name),
  ]);
  let prunedBackups = 0;
  let retentionErrors = 0;
  for (const entry of matching.filter(({ name }) => !retainedNames.has(name))) {
    try {
      await unlink(path.join(directory, entry.name));
      prunedBackups += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      retentionErrors += 1;
    }
  }
  return {
    retainedBackups: matching.length - prunedBackups,
    prunedBackups,
    retentionErrors,
  };
}

export async function createSqliteBackup(options: CreateBackupOptions): Promise<BackupMetadata> {
  const retention = options.retention ?? DEFAULT_RETENTION;
  if (!Number.isSafeInteger(retention) || retention < 1) throw new TypeError('Backup retention must be a positive safe integer');
  if (!options.sourcePath) throw new TypeError('Backup source path is required');
  if (!options.backupDirectory) throw new TypeError('Backup destination directory is required');

  await requireBackupDirectory(options.backupDirectory);
  const createdAt = (options.now ?? (() => new Date()))();
  const timestamp = formatTimestamp(createdAt);
  const nonceBytes = (options.randomBytes ?? cryptoRandomBytes)(8);
  if (!(nonceBytes instanceof Uint8Array) || nonceBytes.byteLength !== 8) {
    throw new TypeError('Backup random source must return exactly 8 bytes');
  }
  const nonce = Buffer.from(nonceBytes).toString('hex');
  const filename = `fireside-backup-${timestamp}-${nonce}.sqlite3`;
  if (!isBackupFilename(filename)) throw new Error('Generated backup filename is invalid');
  const finalPath = path.join(options.backupDirectory, filename);
  const temporaryPath = path.join(options.backupDirectory, `.${filename}.${process.pid}.tmp`);
  await requireAbsent(finalPath);

  let source: Database.Database | null = null;
  let temporaryCreated = false;
  let published = false;
  try {
    source = new Database(options.sourcePath, { readonly: true, fileMustExist: true });
    source.pragma('query_only = ON');
    const temporary = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    await temporary.close();
    await source.backup(temporaryPath);
    source.close();
    source = null;

    await chmod(temporaryPath, 0o600);
    const fingerprint = readDatabaseFingerprint(temporaryPath);
    const fileInfo = await stat(temporaryPath);
    const sha256 = await sha256File(temporaryPath);
    await rename(temporaryPath, finalPath);
    temporaryCreated = false;
    published = true;

    const retentionResult = await pruneBackups(options.backupDirectory, retention, filename);
    return {
      createdAt: createdAt.toISOString(),
      filename,
      bytes: fileInfo.size,
      sha256,
      topicCount: fingerprint.topicCount,
      participantCount: fingerprint.participantCount,
      orderVersion: fingerprint.orderVersion,
      ...retentionResult,
    };
  } catch (error) {
    if (!published && temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    throw error;
  } finally {
    if (source?.open) source.close();
  }
}
