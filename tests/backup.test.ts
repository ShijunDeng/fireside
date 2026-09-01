import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  chown,
  copyFile,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  BACKUP_MUTEX_FILENAME,
  BACKUP_ORPHAN_MINIMUM_AGE_MS,
  createSqliteBackup,
  isBackupFilename,
  readDatabaseFingerprint,
  type BackupFaultPoint,
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

async function entriesWithoutMutex(directory: string) {
  return (await readdir(directory)).filter((name) => name !== BACKUP_MUTEX_FILENAME);
}

async function exists(filename: string) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('SQLite 一致备份', () => {
  it('业务值指纹允许纯 schema 扩展，并捕获不递增 revision 的内容篡改', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, 'fireside.db');
    const database = new Database(sourcePath);
    createBackupSchema(database);
    insertSensitiveFixture(database);
    database.close();

    const before = readDatabaseFingerprint(sourcePath);

    const schemaMigration = new Database(sourcePath);
    schemaMigration.exec(`
      ALTER TABLE topics ADD COLUMN migration_note TEXT NOT NULL DEFAULT 'new';
      CREATE INDEX idx_topics_migration_note ON topics(migration_note);
    `);
    schemaMigration.close();

    const afterSchemaOnly = readDatabaseFingerprint(sourcePath);
    assert.equal(afterSchemaOnly.businessDataSha256, before.businessDataSha256);
    assert.notEqual(afterSchemaOnly.contentSha256, before.contentSha256);

    const maliciousMigration = new Database(sourcePath);
    maliciousMigration.prepare(`
      UPDATE topics
      SET title = '被静默改写的标题',
          summary = '被静默改写的简介',
          meeting_url = 'https://different.example.test/join?pwd=also-secret'
      WHERE id = 1
    `).run();
    maliciousMigration.close();

    const afterContentChange = readDatabaseFingerprint(sourcePath);
    assert.equal(afterContentChange.topicCount, afterSchemaOnly.topicCount);
    assert.equal(afterContentChange.participantCount, afterSchemaOnly.participantCount);
    assert.equal(afterContentChange.orderVersion, afterSchemaOnly.orderVersion);
    assert.equal(afterContentChange.revisionsSha256, afterSchemaOnly.revisionsSha256);
    assert.equal(afterContentChange.sensitivePresenceSha256, afterSchemaOnly.sensitivePresenceSha256);
    assert.notEqual(afterContentChange.businessDataSha256, afterSchemaOnly.businessDataSha256);
  });

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
      assert.deepEqual(await entriesWithoutMutex(backupDirectory), [metadata.filename]);
      const standalone = new Database(backupPath, { readonly: true, fileMustExist: true });
      assert.equal(standalone.pragma('journal_mode', { simple: true }), 'delete');
      standalone.close();
      assert.deepEqual(await entriesWithoutMutex(backupDirectory), [metadata.filename]);

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
    assert.equal(entries.some((entry) => entry.name.endsWith('-wal') || entry.name.endsWith('-shm')), false);
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

  it('按 file sync → rename → directory sync → prune → directory sync 建立故障边界', async () => {
    const cases: {
      failure: BackupFaultPoint;
      rejects: boolean;
      finalExists: boolean;
      oldExists: boolean;
      expectedPoints: BackupFaultPoint[];
    }[] = [
      {
        failure: 'temporary-file-sync',
        rejects: true,
        finalExists: false,
        oldExists: true,
        expectedPoints: ['temporary-file-sync'],
      },
      {
        failure: 'published-directory-sync',
        rejects: true,
        finalExists: true,
        oldExists: true,
        expectedPoints: ['temporary-file-sync', 'published-directory-sync'],
      },
      {
        failure: 'prune',
        rejects: false,
        finalExists: true,
        oldExists: true,
        expectedPoints: ['temporary-file-sync', 'published-directory-sync', 'prune', 'pruned-directory-sync'],
      },
      {
        failure: 'pruned-directory-sync',
        rejects: true,
        finalExists: true,
        oldExists: false,
        expectedPoints: ['temporary-file-sync', 'published-directory-sync', 'prune', 'pruned-directory-sync'],
      },
    ];

    for (const scenario of cases) {
      const directory = await temporaryDirectory();
      const sourcePath = path.join(directory, 'fireside.db');
      const backupDirectory = path.join(directory, 'backups');
      await mkdir(backupDirectory, { mode: 0o700 });
      const db = new Database(sourcePath);
      createBackupSchema(db);
      insertSensitiveFixture(db);
      db.close();

      const oldName = 'fireside-backup-20260901T000000000Z-1111111111111111.sqlite3';
      const finalName = 'fireside-backup-20260902T040506007Z-2222222222222222.sqlite3';
      const oldPath = path.join(backupDirectory, oldName);
      const finalPath = path.join(backupDirectory, finalName);
      await writeFile(oldPath, 'older validated backup', { mode: 0o600 });
      const points: BackupFaultPoint[] = [];
      const injected = new Error(`injected ${scenario.failure}`);
      const operation = createSqliteBackup({
        sourcePath,
        backupDirectory,
        retention: 1,
        now: () => new Date('2026-09-02T04:05:06.007Z'),
        randomBytes: () => new Uint8Array(8).fill(0x22),
        faultInjector: (point) => {
          points.push(point);
          if (point === scenario.failure) throw injected;
        },
      });

      let metadata;
      if (scenario.rejects) {
        await assert.rejects(operation, injected);
      } else {
        metadata = await operation;
      }
      assert.deepEqual(points, scenario.expectedPoints, scenario.failure);
      assert.equal(await exists(finalPath), scenario.finalExists, `${scenario.failure} final`);
      assert.equal(await exists(oldPath), scenario.oldExists, `${scenario.failure} old`);
      assert.equal(
        (await readdir(backupDirectory)).some((name) => name.includes('.tmp')),
        false,
        `${scenario.failure} must not leave caught-failure temporaries`,
      );
      if (scenario.failure === 'prune') {
        assert.equal(metadata?.retentionErrors, 1);
        assert.equal(metadata?.prunedBackups, 0);
        assert.equal(metadata?.retainedBackups, 2);
      }
      if (scenario.failure === 'temporary-file-sync' || scenario.failure === 'published-directory-sync') {
        assert.equal(points.includes('prune'), false, 'an undurable new backup must never prune an old backup');
      }
    }
  });

  it('同目录任务互斥，持锁任务完成后无需清理陈旧 lock 即可继续', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, 'fireside.db');
    const backupDirectory = path.join(directory, 'backups');
    await mkdir(backupDirectory, { mode: 0o700 });
    const db = new Database(sourcePath);
    createBackupSchema(db);
    insertSensitiveFixture(db);
    db.close();

    let reachedSync!: () => void;
    let releaseSync!: () => void;
    const atSync = new Promise<void>((resolve) => { reachedSync = resolve; });
    const syncBarrier = new Promise<void>((resolve) => { releaseSync = resolve; });
    const first = createSqliteBackup({
      sourcePath,
      backupDirectory,
      now: () => new Date('2026-09-02T04:05:06.007Z'),
      randomBytes: () => new Uint8Array(8).fill(1),
      faultInjector: async (point) => {
        if (point !== 'temporary-file-sync') return;
        reachedSync();
        await syncBarrier;
      },
    });
    await atSync;

    try {
      await assert.rejects(createSqliteBackup({
        sourcePath,
        backupDirectory,
        now: () => new Date('2026-09-02T04:06:06.007Z'),
        randomBytes: () => new Uint8Array(8).fill(2),
      }), /already in progress/);
    } finally {
      releaseSync();
    }
    await first;

    const next = await createSqliteBackup({
      sourcePath,
      backupDirectory,
      now: () => new Date('2026-09-02T04:07:06.007Z'),
      randomBytes: () => new Uint8Array(8).fill(3),
    });
    assert.equal(await exists(path.join(backupDirectory, next.filename)), true);
    assert.equal((await stat(path.join(backupDirectory, BACKUP_MUTEX_FILENAME))).mode & 0o777, 0o600);
  });

  it('下一轮只回收过期、指定所有者、单链接普通孤儿，保留新鲜/非匹配/链接/目录/非 root 项', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, 'fireside.db');
    const backupDirectory = path.join(directory, 'backups');
    await mkdir(backupDirectory, { mode: 0o700 });
    const db = new Database(sourcePath);
    createBackupSchema(db);
    insertSensitiveFixture(db);
    db.close();

    const currentUid = process.getuid?.() ?? 0;
    const oldAt = new Date('2026-09-01T00:00:00.000Z');
    const freshAt = new Date('2026-09-10T00:00:00.001Z');
    const finalStem = 'fireside-backup-20260830T000000000Z-aaaaaaaaaaaaaaaa.sqlite3';
    const oldMain = `.${finalStem}.7001.tmp`;
    const oldOrphans = [oldMain, `${oldMain}-wal`, `${oldMain}-shm`, `${oldMain}-journal`];
    for (const name of oldOrphans) {
      const filename = path.join(backupDirectory, name);
      await writeFile(filename, name, { mode: 0o600 });
      await utimes(filename, oldAt, oldAt);
    }

    const fresh = '.fireside-backup-20260909T120000001Z-bbbbbbbbbbbbbbbb.sqlite3.7002.tmp';
    await writeFile(path.join(backupDirectory, fresh), 'fresh in-flight candidate', { mode: 0o600 });
    await utimes(path.join(backupDirectory, fresh), freshAt, freshAt);

    const nonMatching = '.fireside-backup-stale.tmp';
    await writeFile(path.join(backupDirectory, nonMatching), 'operator file', { mode: 0o600 });
    await utimes(path.join(backupDirectory, nonMatching), oldAt, oldAt);

    const symlinkTarget = path.join(backupDirectory, 'symlink-target.txt');
    const symlinkName = '.fireside-backup-20260830T000000000Z-cccccccccccccccc.sqlite3.7003.tmp';
    await writeFile(symlinkTarget, 'must remain', { mode: 0o600 });
    await symlink(symlinkTarget, path.join(backupDirectory, symlinkName));
    await lutimes(path.join(backupDirectory, symlinkName), oldAt, oldAt);

    const directoryName = '.fireside-backup-20260830T000000000Z-dddddddddddddddd.sqlite3.7004.tmp';
    await mkdir(path.join(backupDirectory, directoryName));
    await utimes(path.join(backupDirectory, directoryName), oldAt, oldAt);

    const hardlinkTarget = path.join(backupDirectory, 'hardlink-target.txt');
    const hardlinkName = '.fireside-backup-20260830T000000000Z-eeeeeeeeeeeeeeee.sqlite3.7005.tmp';
    await writeFile(hardlinkTarget, 'linked operator data', { mode: 0o600 });
    await link(hardlinkTarget, path.join(backupDirectory, hardlinkName));
    await utimes(path.join(backupDirectory, hardlinkName), oldAt, oldAt);

    const nonRootName = '.fireside-backup-20260830T000000000Z-ffffffffffffffff.sqlite3.7006.tmp';
    const nonRootPath = path.join(backupDirectory, nonRootName);
    await writeFile(nonRootPath, 'different owner', { mode: 0o600 });
    await utimes(nonRootPath, oldAt, oldAt);
    if (currentUid === 0) await chown(nonRootPath, 65_534, 65_534);

    assert.ok(new Date('2026-09-10T12:00:00.001Z').getTime() - freshAt.getTime() < BACKUP_ORPHAN_MINIMUM_AGE_MS);
    await createSqliteBackup({
      sourcePath,
      backupDirectory,
      now: () => new Date('2026-09-10T12:00:00.001Z'),
      randomBytes: () => new Uint8Array(8).fill(4),
      orphanOwnerUid: currentUid,
    });

    for (const name of oldOrphans) assert.equal(await exists(path.join(backupDirectory, name)), false, name);
    for (const name of [fresh, nonMatching, symlinkName, directoryName, hardlinkName]) {
      assert.equal(await exists(path.join(backupDirectory, name)), true, name);
    }
    assert.equal((await lstat(path.join(backupDirectory, symlinkName))).isSymbolicLink(), true);
    assert.equal((await stat(path.join(backupDirectory, hardlinkName))).nlink, 2);
    if (currentUid === 0) {
      assert.equal((await lstat(nonRootPath)).uid, 65_534);
      assert.equal(await exists(nonRootPath), true);
    } else {
      await writeFile(nonRootPath, 'non-root crash residue', { mode: 0o600 });
      await utimes(nonRootPath, oldAt, oldAt);
      await createSqliteBackup({
        sourcePath,
        backupDirectory,
        now: () => new Date('2026-09-10T12:01:00.001Z'),
        randomBytes: () => new Uint8Array(8).fill(5),
      });
      assert.notEqual((await lstat(nonRootPath)).uid, 0);
      assert.equal(await exists(nonRootPath), true);
    }
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
    const before = (await entriesWithoutMutex(backupDirectory)).sort();

    await assert.rejects(createSqliteBackup({
      sourcePath,
      backupDirectory,
      retention: 1,
      now: () => new Date('2026-09-02T04:05:06.007Z'),
      randomBytes: () => new Uint8Array(8).fill(2),
    }));
    assert.deepEqual((await entriesWithoutMutex(backupDirectory)).sort(), before);
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
