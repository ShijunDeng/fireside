import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  createSqliteBackup,
  isBackupFilename,
  readDatabaseFingerprint,
} from '../server/backup.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-backup-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createBackupSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      proposer TEXT NOT NULL,
      presenter TEXT,
      tags TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_at TEXT,
      duration INTEGER,
      room TEXT,
      meeting_url TEXT,
      takeaway TEXT,
      material_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE topic_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(topic_id, normalized_name)
    );
    CREATE TABLE topic_order_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO topic_order_state (id, version) VALUES (1, 0);
    CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

function insertSensitiveFixture(db: Database.Database) {
  const insertTopic = db.prepare(`
    INSERT INTO topics
      (position, revision, title, summary, proposer, presenter, tags, status, scheduled_at,
       duration, room, meeting_url, takeaway, material_url, created_at, updated_at, archived_at)
    VALUES
      (@position, @revision, @title, @summary, @proposer, @presenter, @tags, @status, @scheduledAt,
       @duration, @room, @meetingUrl, @takeaway, @materialUrl, @createdAt, @updatedAt, @archivedAt)
  `);
  const createdAt = '2026-09-02T04:00:00.000Z';
  db.transaction(() => {
    insertTopic.run({
      position: 1,
      revision: 4,
      title: '只应进入指纹的秘密议题',
      summary: '验证 WAL 中的完整业务内容。',
      proposer: '发起人甲',
      presenter: '分享人乙',
      tags: '["备份"]',
      status: 'SCHEDULED',
      scheduledAt: '2026-09-08T11:30:00.000Z',
      duration: 45,
      room: '私密会议室',
      meetingUrl: 'https://secret.example.test/join?pwd=do-not-log',
      takeaway: null,
      materialUrl: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
    });
    insertTopic.run({
      position: 2,
      revision: 9,
      title: '已归档指纹议题',
      summary: '恢复时应保留余温与资料存在性。',
      proposer: '发起人丙',
      presenter: '分享人丙',
      tags: '["归档"]',
      status: 'ARCHIVED',
      scheduledAt: '2026-08-20T11:30:00.000Z',
      duration: 30,
      room: '围炉会议室',
      meetingUrl: null,
      takeaway: '不应输出的归档摘要',
      materialUrl: 'https://materials.example.test/private',
      createdAt,
      updatedAt: createdAt,
      archivedAt: '2026-08-20T12:00:00.000Z',
    });
    db.prepare(`
      INSERT INTO topic_participants (topic_id, name, normalized_name, created_at)
      VALUES (1, ?, ?, ?), (1, ?, ?, ?), (2, ?, ?, ?)
    `).run(
      '不应输出的姓名一', '不应输出的姓名一', createdAt,
      '不应输出的姓名二', '不应输出的姓名二', createdAt,
      '不应输出的姓名三', '不应输出的姓名三', createdAt,
    );
    db.prepare('UPDATE topic_order_state SET version = 7 WHERE id = 1').run();
    db.prepare("INSERT INTO app_state (key, value) VALUES ('sample_data_initialized', 'seed-disabled')").run();
  }).immediate();
}

async function sha256(filename: string) {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

describe('SQLite 一致备份', () => {
  it('在 WAL 未 checkpoint 时生成 0600 完整快照，可隔离恢复并保持内容指纹', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, 'fireside.db');
    const backupDirectory = path.join(directory, 'backups');
    await mkdir(backupDirectory, { mode: 0o700 });
    const writer = new Database(sourcePath);
    try {
      assert.equal(writer.pragma('journal_mode = WAL', { simple: true }), 'wal');
      writer.pragma('wal_autocheckpoint = 0');
      createBackupSchema(writer);
      writer.pragma('wal_checkpoint(TRUNCATE)');
      insertSensitiveFixture(writer);
      assert.ok((await stat(`${sourcePath}-wal`)).size > 32, 'fixture rows must still be present in WAL');

      const rawMainCopy = path.join(directory, 'raw-main-copy.db');
      await copyFile(sourcePath, rawMainCopy);
      const rawMain = new Database(rawMainCopy, { readonly: true, fileMustExist: true });
      assert.equal((rawMain.prepare('SELECT COUNT(*) AS count FROM topics').get() as { count: number }).count, 0);
      rawMain.close();

      const sourceFingerprint = readDatabaseFingerprint(sourcePath);
      const metadata = await createSqliteBackup({
        sourcePath,
        backupDirectory,
        now: () => new Date('2026-09-02T04:05:06.007Z'),
        randomBytes: () => Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
      });
      assert.equal(metadata.filename, 'fireside-backup-20260902T040506007Z-0001020304050607.sqlite3');
      assert.equal(isBackupFilename(metadata.filename), true);
      assert.equal(metadata.createdAt, '2026-09-02T04:05:06.007Z');
      assert.equal(metadata.topicCount, 2);
      assert.equal(metadata.participantCount, 3);
      assert.equal(metadata.orderVersion, 7);
      assert.equal(metadata.retainedBackups, 1);
      assert.equal(metadata.prunedBackups, 0);
      assert.equal(metadata.retentionErrors, 0);

      const backupPath = path.join(backupDirectory, metadata.filename);
      assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
      assert.equal(metadata.bytes, (await stat(backupPath)).size);
      assert.equal(metadata.sha256, await sha256(backupPath));
      assert.deepEqual(readDatabaseFingerprint(backupPath), sourceFingerprint);
      assert.deepEqual((await readdir(backupDirectory)).filter((name) => name.endsWith('.tmp')), []);

      const serializedMetadata = JSON.stringify(metadata);
      for (const secret of [
        '只应进入指纹的秘密议题',
        '不应输出的姓名一',
        'do-not-log',
        '不应输出的归档摘要',
      ]) assert.equal(serializedMetadata.includes(secret), false);

      const restoredPath = path.join(directory, 'isolated-restore.db');
      await copyFile(backupPath, restoredPath);
      await chmod(restoredPath, 0o600);
      assert.deepEqual(readDatabaseFingerprint(restoredPath), sourceFingerprint);
      const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
      assert.equal((restored.prepare('SELECT meeting_url FROM topics WHERE id = 1').get() as { meeting_url: string }).meeting_url,
        'https://secret.example.test/join?pwd=do-not-log');
      assert.equal((restored.prepare('SELECT COUNT(*) AS count FROM topic_participants').get() as { count: number }).count, 3);
      restored.close();

      writer.prepare("UPDATE topics SET meeting_url = 'https://changed.example.test' WHERE id = 1").run();
      assert.notEqual(readDatabaseFingerprint(sourcePath).contentSha256, sourceFingerprint.contentSha256);
      assert.deepEqual(readDatabaseFingerprint(backupPath), sourceFingerprint);
    } finally {
      writer.close();
    }
  });

  it('仅在成功后保留最新 14 份，严格保留非匹配文件和目录', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, 'fireside.db');
    const backupDirectory = path.join(directory, 'backups');
    await mkdir(backupDirectory, { mode: 0o700 });
    const db = new Database(sourcePath);
    createBackupSchema(db);
    insertSensitiveFixture(db);
    db.close();

    const preservedNames = [
      'README.txt',
      'fireside-backup-20260902T000000000Z-0123456789abcdef.sqlite3.bak',
      'fireside-backup-20269999T999999999Z-0123456789abcdef.sqlite3',
      '.fireside-backup-stale.tmp',
    ];
    for (const name of preservedNames) await writeFile(path.join(backupDirectory, name), 'must remain', { mode: 0o600 });
    const matchingDirectory = 'fireside-backup-20260101T000000000Z-aaaaaaaaaaaaaaaa.sqlite3';
    await mkdir(path.join(backupDirectory, matchingDirectory));

    const created: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      const metadata = await createSqliteBackup({
        sourcePath,
        backupDirectory,
        now: () => new Date(Date.UTC(2026, 8, index + 1, 1, 2, 3, index)),
        randomBytes: () => Uint8Array.from({ length: 8 }, () => index),
      });
      created.push(metadata.filename);
      assert.equal(metadata.retentionErrors, 0);
      assert.equal(metadata.retainedBackups, Math.min(index + 1, 14));
      assert.equal(metadata.prunedBackups, index < 14 ? 0 : 1);
    }

    const entries = await readdir(backupDirectory, { withFileTypes: true });
    const retained = entries.filter((entry) => entry.isFile() && isBackupFilename(entry.name)).map((entry) => entry.name).sort();
    assert.deepEqual(retained, created.slice(-14).sort());
    assert.equal(entries.some((entry) => entry.name === created[0]), false);
    assert.equal(entries.some((entry) => entry.name === created[1]), false);
    for (const name of [...preservedNames, matchingDirectory]) {
      assert.equal(entries.some((entry) => entry.name === name), true, `${name} must not be pruned`);
    }
    for (const name of retained) assert.equal((await stat(path.join(backupDirectory, name))).mode & 0o777, 0o600);
  });

  it('系统时钟回退时仍保留本次已发布备份，并只清理严格匹配的旧文件', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, 'fireside.db');
    const backupDirectory = path.join(directory, 'backups');
    await mkdir(backupDirectory, { mode: 0o700 });
    const db = new Database(sourcePath);
    createBackupSchema(db);
    insertSensitiveFixture(db);
    db.close();

    const newerBackups = [
      'fireside-backup-20260910T000000000Z-1111111111111111.sqlite3',
      'fireside-backup-20260911T000000000Z-2222222222222222.sqlite3',
    ];
    for (const name of newerBackups) await writeFile(path.join(backupDirectory, name), 'older run', { mode: 0o600 });
    const metadata = await createSqliteBackup({
      sourcePath,
      backupDirectory,
      retention: 2,
      now: () => new Date('2026-09-01T00:00:00.000Z'),
      randomBytes: () => new Uint8Array(8).fill(3),
    });

    assert.equal((await stat(path.join(backupDirectory, metadata.filename))).isFile(), true);
    assert.equal(metadata.retainedBackups, 2);
    assert.equal(metadata.prunedBackups, 1);
    assert.equal(metadata.retentionErrors, 0);
    assert.deepEqual(
      (await readdir(backupDirectory)).filter(isBackupFilename).sort(),
      [metadata.filename, newerBackups[1]].sort(),
    );
  });

  it('校验失败不发布最终文件、不留临时文件且不触碰旧备份', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, 'incomplete.db');
    const backupDirectory = path.join(directory, 'backups');
    await mkdir(backupDirectory, { mode: 0o700 });
    const incomplete = new Database(sourcePath);
    incomplete.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT)');
    incomplete.prepare('INSERT INTO unrelated (value) VALUES (?)').run('not a Fireside database');
    incomplete.close();

    const oldBackup = 'fireside-backup-20260901T000000000Z-1111111111111111.sqlite3';
    const unrelated = 'operator-notes.txt';
    await writeFile(path.join(backupDirectory, oldBackup), 'existing backup must remain', { mode: 0o600 });
    await writeFile(path.join(backupDirectory, unrelated), 'notes must remain', { mode: 0o600 });
    const before = (await readdir(backupDirectory)).sort();

    await assert.rejects(createSqliteBackup({
      sourcePath,
      backupDirectory,
      retention: 1,
      now: () => new Date('2026-09-02T04:05:06.007Z'),
      randomBytes: () => new Uint8Array(8).fill(2),
    }));
    assert.deepEqual((await readdir(backupDirectory)).sort(), before);
  });

  it('CLI 仅从环境变量取得路径，成功输出非敏感 JSON，失败只输出稳定错误码', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, 'fireside.db');
    const backupDirectory = path.join(directory, 'backups');
    await mkdir(backupDirectory, { mode: 0o700 });
    const db = new Database(sourcePath);
    createBackupSchema(db);
    insertSensitiveFixture(db);
    db.close();

    const success = spawnSync(process.execPath, ['--import', 'tsx', 'server/backup-cli.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_PATH: sourcePath,
        BACKUP_DIRECTORY: backupDirectory,
        BACKUP_RETENTION: '2',
      },
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stderr, '');
    const result = JSON.parse(success.stdout) as { ok: boolean; filename: string; topicCount: number; participantCount: number };
    assert.equal(result.ok, true);
    assert.equal(isBackupFilename(result.filename), true);
    assert.equal(result.topicCount, 2);
    assert.equal(result.participantCount, 3);
    for (const secret of ['do-not-log', '不应输出的姓名一', '只应进入指纹的秘密议题']) {
      assert.equal(success.stdout.includes(secret), false);
    }

    const failureEnv = { ...process.env };
    delete failureEnv.DATABASE_PATH;
    delete failureEnv.BACKUP_DIRECTORY;
    delete failureEnv.BACKUP_RETENTION;
    const failure = spawnSync(process.execPath, ['--import', 'tsx', 'server/backup-cli.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: failureEnv,
    });
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.equal(failure.stderr, '{"ok":false,"error":"backup_failed"}\n');
  });
});
