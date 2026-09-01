import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';

describe('围炉夜话 API', () => {
  let app: FastifyInstance;

  before(async () => {
    app = buildApp({ databasePath: ':memory:', seed: false, serveStatic: false });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('返回健康状态', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
  });

  it('完成创建、认领、排期和归档的完整流程', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/topics',
      payload: {
        title: '测试驱动的围炉议题',
        summary: '验证一个议题从火种到归档的完整生命周期。',
        proposer: '测试者',
        tags: ['测试', '工程'],
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().status, 'OPEN');
    const id = created.json().id as number;

    const claimed = await app.inject({ method: 'POST', url: `/api/topics/${id}/claim`, payload: { presenter: '分享者' } });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.json().status, 'CLAIMED');
    assert.equal(claimed.json().presenter, '分享者');

    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await app.inject({
      method: 'POST',
      url: `/api/topics/${id}/schedule`,
      payload: { scheduledAt, duration: 45, room: '测试会议室' },
    });
    assert.equal(scheduled.statusCode, 200);
    assert.equal(scheduled.json().status, 'SCHEDULED');
    assert.equal(scheduled.json().duration, 45);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/topics/${id}/archive`,
      payload: { takeaway: '测试覆盖完整流程。', materialUrl: 'https://example.com/notes' },
    });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().status, 'ARCHIVED');
    assert.equal(archived.json().takeaway, '测试覆盖完整流程。');

    const topics = await app.inject({ method: 'GET', url: '/api/topics?status=ARCHIVED' });
    assert.equal(topics.statusCode, 200);
    assert.equal(topics.json().length, 1);

    const stats = await app.inject({ method: 'GET', url: '/api/stats' });
    assert.equal(stats.statusCode, 200);
    assert.equal(stats.json().archived, 1);
  });

  it('阻止重复认领和越级排期', async () => {
    const first = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '并发认领', summary: '同一个议题只能有一位分享者。', proposer: 'A', tags: [] },
    });
    const firstId = first.json().id as number;
    const claim = await app.inject({ method: 'POST', url: `/api/topics/${firstId}/claim`, payload: { presenter: 'B' } });
    assert.equal(claim.statusCode, 200);
    const duplicate = await app.inject({ method: 'POST', url: `/api/topics/${firstId}/claim`, payload: { presenter: 'C' } });
    assert.equal(duplicate.statusCode, 409);

    const second = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '越级排期', summary: '尚未认领时不能排期。', proposer: 'A', tags: [] },
    });
    const invalidSchedule = await app.inject({
      method: 'POST', url: `/api/topics/${second.json().id}/schedule`,
      payload: { scheduledAt: new Date().toISOString(), duration: 30, room: '线上' },
    });
    assert.equal(invalidSchedule.statusCode, 409);
  });

  it('支持自荐发布与生命周期纠错路径', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/topics',
      payload: {
        title: '自荐与纠错议题',
        summary: '验证发起人直接分享以及每个阶段的撤销动作。',
        proposer: '自荐者',
        presenter: '自荐者',
        tags: ['流程'],
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().status, 'CLAIMED');
    assert.equal(created.json().presenter, '自荐者');
    const id = created.json().id as number;

    const released = await app.inject({ method: 'POST', url: `/api/topics/${id}/release`, payload: {} });
    assert.equal(released.statusCode, 200);
    assert.equal(released.json().status, 'OPEN');
    assert.equal(released.json().presenter, null);
    const duplicateRelease = await app.inject({ method: 'POST', url: `/api/topics/${id}/release`, payload: {} });
    assert.equal(duplicateRelease.statusCode, 409);

    await app.inject({ method: 'POST', url: `/api/topics/${id}/claim`, payload: { presenter: '接力者' } });
    const scheduledAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const scheduled = await app.inject({
      method: 'POST',
      url: `/api/topics/${id}/schedule`,
      payload: { scheduledAt, duration: 50, room: '纠错会议室' },
    });
    assert.equal(scheduled.statusCode, 200);
    const archived = await app.inject({
      method: 'POST',
      url: `/api/topics/${id}/archive`,
      payload: { takeaway: '这段内容将在撤销归档时清空。', materialUrl: 'https://example.com/flow' },
    });
    assert.equal(archived.statusCode, 200);

    const unarchived = await app.inject({ method: 'POST', url: `/api/topics/${id}/unarchive`, payload: {} });
    assert.equal(unarchived.statusCode, 200);
    assert.equal(unarchived.json().status, 'SCHEDULED');
    assert.equal(unarchived.json().scheduledAt, scheduledAt);
    assert.equal(unarchived.json().presenter, '接力者');
    assert.equal(unarchived.json().takeaway, null);
    assert.equal(unarchived.json().materialUrl, null);
    assert.equal(unarchived.json().archivedAt, null);

    const unscheduled = await app.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, payload: {} });
    assert.equal(unscheduled.statusCode, 200);
    assert.equal(unscheduled.json().status, 'CLAIMED');
    assert.equal(unscheduled.json().presenter, '接力者');
    assert.equal(unscheduled.json().scheduledAt, null);
    assert.equal(unscheduled.json().duration, null);
    assert.equal(unscheduled.json().room, null);
    const duplicateUnschedule = await app.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, payload: {} });
    assert.equal(duplicateUnschedule.statusCode, 409);
  });

  it('支持独立会议链接与报名、取消和名单冻结', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '线上参会议题', summary: '验证参会入口和报名闭环。', proposer: '组织者', presenter: '组织者', tags: ['线上'] },
    });
    const id = created.json().id as number;
    const meetingUrl = `https://meet.example.com/fireside/${'long-path-'.repeat(12)}?room=weekly`;
    const scheduled = await app.inject({
      method: 'POST', url: `/api/topics/${id}/schedule`,
      payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 60, room: '线上会议', meetingUrl },
    });
    assert.equal(scheduled.statusCode, 200);
    assert.equal(scheduled.json().meetingUrl, meetingUrl);

    const firstJoin = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: 'Alice' } });
    assert.equal(firstJoin.statusCode, 201);
    const duplicateJoin = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: '  alice  ' } });
    assert.equal(duplicateJoin.statusCode, 409);
    const secondJoin = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: '小林' } });
    assert.equal(secondJoin.statusCode, 201);
    const participants = await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` });
    assert.deepEqual((participants.json() as { name: string }[]).map(({ name }) => name), ['Alice', '小林']);
    const topics = await app.inject({ method: 'GET', url: '/api/topics' });
    const topic = (topics.json() as { id: number; participantCount: number }[]).find((item) => item.id === id);
    assert.equal(topic?.participantCount, 2);

    await app.inject({ method: 'POST', url: `/api/topics/${id}/archive`, payload: { takeaway: '参会闭环完成。', materialUrl: '' } });
    const joinArchived = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: '迟到者' } });
    assert.equal(joinArchived.statusCode, 409);
    const leaveArchived = await app.inject({ method: 'DELETE', url: `/api/topics/${id}/participants/${firstJoin.json().id}` });
    assert.equal(leaveArchived.statusCode, 409);

    await app.inject({ method: 'POST', url: `/api/topics/${id}/unarchive`, payload: {} });
    const left = await app.inject({ method: 'DELETE', url: `/api/topics/${id}/participants/${firstJoin.json().id}` });
    assert.equal(left.statusCode, 204);
    const afterLeave = await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` });
    assert.deepEqual((afterLeave.json() as { name: string }[]).map(({ name }) => name), ['小林']);

    const unscheduled = await app.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, payload: {} });
    assert.equal(unscheduled.statusCode, 200);
    assert.equal(unscheduled.json().meetingUrl, null);
    const afterUnschedule = await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` });
    assert.deepEqual(afterUnschedule.json(), []);

    const invalidUrlTopic = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '非法会议链接', summary: '协议必须安全。', proposer: '组织者', presenter: '组织者', tags: [] },
    });
    const invalidUrl = await app.inject({
      method: 'POST', url: `/api/topics/${invalidUrlTopic.json().id}/schedule`,
      payload: { scheduledAt: new Date().toISOString(), duration: 30, room: '线上', meetingUrl: 'javascript:alert(1)' },
    });
    assert.equal(invalidUrl.statusCode, 400);
  });

  it('拒绝缺少关键信息的议题', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/topics', payload: { title: '', summary: '', proposer: '' } });
    assert.equal(response.statusCode, 400);
    assert.ok(response.json().message);
  });

  it('支持更新和删除议题', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '待编辑议题', summary: '修改前的简介。', proposer: '原发起人', tags: ['旧标签'] },
    });
    const id = created.json().id as number;
    const updated = await app.inject({
      method: 'PATCH', url: `/api/topics/${id}`,
      payload: { title: '编辑后的议题', summary: '修改后的简介。', proposer: '新发起人', tags: ['新标签', 'CRUD'] },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().title, '编辑后的议题');
    assert.deepEqual(updated.json().tags, ['新标签', 'CRUD']);

    const invalidUrl = await app.inject({ method: 'PATCH', url: `/api/topics/${id}`, payload: { materialUrl: 'javascript:alert(1)' } });
    assert.equal(invalidUrl.statusCode, 400);
    const bypassState = await app.inject({
      method: 'PATCH', url: `/api/topics/${id}`,
      payload: { scheduledAt: new Date().toISOString(), duration: 30, room: '越级排期' },
    });
    assert.equal(bypassState.statusCode, 409);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/topics/${id}` });
    assert.equal(deleted.statusCode, 204);
    const duplicate = await app.inject({ method: 'DELETE', url: `/api/topics/${id}` });
    assert.equal(duplicate.statusCode, 404);
    const topics = await app.inject({ method: 'GET', url: '/api/topics' });
    assert.equal(topics.json().some((topic: { id: number }) => topic.id === id), false);
  });

  it('持久化完整的手动排序并拒绝不完整列表', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const ids = (before.json() as { id: number }[]).map(({ id }) => id);
    const baseVersion = Number(before.headers['x-order-version']);
    const reversed = [...ids].reverse();
    const reordered = await app.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: reversed, baseVersion } });
    assert.equal(reordered.statusCode, 204);
    assert.equal(Number(reordered.headers['x-order-version']), baseVersion + 1);
    const after = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.deepEqual((after.json() as { id: number }[]).map(({ id }) => id), reversed);

    const currentVersion = Number(after.headers['x-order-version']);
    const incomplete = await app.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: reversed.slice(1), baseVersion: currentVersion } });
    assert.equal(incomplete.statusCode, 400);
    const duplicate = await app.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: [reversed[0], reversed[0]], baseVersion: currentVersion } });
    assert.equal(duplicate.statusCode, 400);
  });
});

describe('数据库兼容性与并发', () => {
  it('演示数据只初始化一次，用户清空后重启不会复活', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-seed-once-'));
    const databasePath = path.join(directory, 'seed.db');
    const firstStart = buildApp({ databasePath, seed: true, serveStatic: false });
    await firstStart.ready();
    const seeded = await firstStart.inject({ method: 'GET', url: '/api/topics' });
    assert.equal(seeded.json().length, 4);
    for (const topic of seeded.json() as { id: number }[]) {
      const deleted = await firstStart.inject({ method: 'DELETE', url: `/api/topics/${topic.id}` });
      assert.equal(deleted.statusCode, 204);
    }
    await firstStart.close();

    const restarted = buildApp({ databasePath, seed: true, serveStatic: false });
    await restarted.ready();
    const afterRestart = await restarted.inject({ method: 'GET', url: '/api/topics' });
    assert.deepEqual(afterRestart.json(), []);
    await restarted.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('首次明确禁用演示数据后，后续启动不会改变决定', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-seed-disabled-'));
    const databasePath = path.join(directory, 'empty.db');
    const firstStart = buildApp({ databasePath, seed: false, serveStatic: false });
    await firstStart.ready();
    await firstStart.close();
    const restarted = buildApp({ databasePath, seed: true, serveStatic: false });
    await restarted.ready();
    const topics = await restarted.inject({ method: 'GET', url: '/api/topics' });
    assert.deepEqual(topics.json(), []);
    await restarted.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('为旧数据库无损添加 position 字段', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-migration-'));
    const databasePath = path.join(directory, 'legacy.db');
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, summary TEXT NOT NULL, proposer TEXT NOT NULL, presenter TEXT,
        tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'OPEN', scheduled_at TEXT,
        duration INTEGER, room TEXT, takeaway TEXT, material_url TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare("INSERT INTO topics (title, summary, proposer, tags, status, created_at, updated_at) VALUES (?, ?, ?, '[]', 'OPEN', ?, ?)")
      .run('旧议题一', '历史内容一', '甲', now, now);
    legacy.prepare("INSERT INTO topics (title, summary, proposer, tags, status, created_at, updated_at) VALUES (?, ?, ?, '[]', 'OPEN', ?, ?)")
      .run('旧议题二', '历史内容二', '乙', now, now);
    legacy.close();

    const migrationApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await migrationApp.ready();
    const response = await migrationApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.deepEqual((response.json() as { title: string; position: number }[]).map(({ title, position }) => ({ title, position })), [
      { title: '旧议题一', position: 1 },
      { title: '旧议题二', position: 2 },
    ]);
    await migrationApp.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('无损归一化旧库的重复位置并可幂等重启', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-duplicate-position-'));
    const databasePath = path.join(directory, 'legacy.db');
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL, summary TEXT NOT NULL, proposer TEXT NOT NULL, presenter TEXT,
        tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'OPEN', scheduled_at TEXT,
        duration INTEGER, room TEXT, takeaway TEXT, material_url TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
    `);
    const timestamps = {
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-02T11:00:00.000Z',
      scheduledAt: '2026-08-08T12:30:00.000Z',
    };
    const insert = legacy.prepare(`
      INSERT INTO topics
        (position, title, summary, proposer, presenter, tags, status, scheduled_at, duration, room, takeaway, material_url, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(2, '旧议题甲', '甲简介', '甲发起', null, '["迁移甲"]', 'OPEN', null, null, null, null, null, timestamps.createdAt, timestamps.updatedAt, null);
    insert.run(1, '旧议题乙', '乙简介', '乙发起', '乙分享', '["迁移乙"]', 'SCHEDULED', timestamps.scheduledAt, 55, '旧会议室', null, null, timestamps.createdAt, timestamps.updatedAt, null);
    insert.run(1, '旧议题丙', '丙简介', '丙发起', '丙分享', '["迁移丙"]', 'ARCHIVED', timestamps.scheduledAt, 35, '线上', '丙收获', 'https://example.com/legacy', timestamps.createdAt, timestamps.updatedAt, timestamps.scheduledAt);
    const beforeRows = legacy.prepare('SELECT * FROM topics ORDER BY id').all() as Array<Record<string, unknown> & { position: number }>;
    legacy.close();

    const firstStart = buildApp({ databasePath, seed: false, serveStatic: false });
    await firstStart.ready();
    const firstResponse = await firstStart.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.equal(firstResponse.statusCode, 200);
    const firstTopics = firstResponse.json() as Array<{
      position: number; title: string; summary: string; proposer: string; presenter: string | null;
      tags: string[]; status: string; scheduledAt: string | null; duration: number | null;
      room: string | null; takeaway: string | null; materialUrl: string | null;
      createdAt: string; updatedAt: string; archivedAt: string | null;
    }>;
    assert.deepEqual(firstTopics.map(({ title, position }) => ({ title, position })), [
      { title: '旧议题乙', position: 1 },
      { title: '旧议题丙', position: 2 },
      { title: '旧议题甲', position: 3 },
    ]);
    await firstStart.close();

    const verifyBusinessData = new Database(databasePath);
    const afterRows = verifyBusinessData.prepare('SELECT * FROM topics ORDER BY id').all() as Array<Record<string, unknown> & { position: number }>;
    const legacyBusinessColumns = ({ position: _position, meeting_url: _meetingUrl, ...row }: Record<string, unknown> & { position: number }) => row;
    assert.deepEqual(afterRows.map(legacyBusinessColumns), beforeRows.map(legacyBusinessColumns));
    verifyBusinessData.close();

    const secondStart = buildApp({ databasePath, seed: false, serveStatic: false });
    await secondStart.ready();
    const secondResponse = await secondStart.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.deepEqual(secondResponse.json(), firstTopics);
    await secondStart.close();

    const migrated = new Database(databasePath);
    const index = (migrated.prepare("PRAGMA index_list('topics')").all() as { name: string; unique: number }[])
      .find(({ name }) => name === 'idx_topics_position');
    assert.equal(index?.unique, 1);
    assert.throws(() => migrated.prepare('UPDATE topics SET position = 1 WHERE position = 2').run(), /UNIQUE constraint failed/);
    migrated.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('把同名非唯一位置索引升级为唯一索引', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-nonunique-index-'));
    const databasePath = path.join(directory, 'legacy.db');
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, position INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL, summary TEXT NOT NULL, proposer TEXT NOT NULL, presenter TEXT,
        tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'OPEN', scheduled_at TEXT,
        duration INTEGER, room TEXT, takeaway TEXT, material_url TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE INDEX idx_topics_position ON topics(position);
    `);
    const now = new Date().toISOString();
    const insert = legacy.prepare("INSERT INTO topics (position, title, summary, proposer, created_at, updated_at) VALUES (1, ?, ?, '迁移测试', ?, ?)");
    insert.run('同名索引甲', '甲简介', now, now);
    insert.run('同名索引乙', '乙简介', now, now);
    legacy.close();

    const migrationApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await migrationApp.ready();
    const response = await migrationApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.deepEqual((response.json() as { position: number }[]).map(({ position }) => position), [1, 2]);
    await migrationApp.close();
    const migrated = new Database(databasePath);
    const index = (migrated.prepare("PRAGMA index_list('topics')").all() as { name: string; unique: number }[])
      .find(({ name }) => name === 'idx_topics_position');
    assert.equal(index?.unique, 1);
    migrated.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('两个应用实例并发认领时只有一个成功', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-concurrency-'));
    const databasePath = path.join(directory, 'shared.db');
    const firstApp = buildApp({ databasePath, seed: false, serveStatic: false });
    const secondApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await Promise.all([firstApp.ready(), secondApp.ready()]);
    const created = await firstApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '并发火种', summary: '只能被一个人成功认领。', proposer: '发起人', tags: [] },
    });
    const id = created.json().id as number;
    const [first, second] = await Promise.all([
      firstApp.inject({ method: 'POST', url: `/api/topics/${id}/claim`, payload: { presenter: '认领人甲' } }),
      secondApp.inject({ method: 'POST', url: `/api/topics/${id}/claim`, payload: { presenter: '认领人乙' } }),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
    const winner = first.statusCode === 200 ? first.json().presenter : second.json().presenter;
    const topics = await firstApp.inject({ method: 'GET', url: '/api/topics' });
    assert.equal(topics.json()[0].presenter, winner);
    await Promise.all([firstApp.close(), secondApp.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  it('普通编辑与排期交错时不会覆盖生命周期字段', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-update-race-'));
    const databasePath = path.join(directory, 'shared.db');
    let signalRead!: () => void;
    let releaseUpdate!: () => void;
    const readReached = new Promise<void>((resolve) => { signalRead = resolve; });
    const updateReleased = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const editingApp = buildApp({
      databasePath, seed: false, serveStatic: false,
      beforeTopicUpdate: async () => { signalRead(); await updateReleased; },
    });
    const lifecycleApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await Promise.all([editingApp.ready(), lifecycleApp.ready()]);
    const created = await lifecycleApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '并发编辑议题', summary: '编辑标题时另一实例进行排期。', proposer: '发起人', tags: [] },
    });
    const id = created.json().id as number;
    await lifecycleApp.inject({ method: 'POST', url: `/api/topics/${id}/claim`, payload: { presenter: '分享人' } });

    const pendingEdit = editingApp.inject({ method: 'PATCH', url: `/api/topics/${id}`, payload: { title: '并发后的新标题' } });
    await readReached;
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await lifecycleApp.inject({
      method: 'POST', url: `/api/topics/${id}/schedule`,
      payload: { scheduledAt, duration: 50, room: '并发测试会议室' },
    });
    assert.equal(scheduled.statusCode, 200);
    releaseUpdate();
    const edited = await pendingEdit;
    assert.equal(edited.statusCode, 200);

    const topics = await lifecycleApp.inject({ method: 'GET', url: '/api/topics' });
    const finalTopic = topics.json()[0];
    assert.equal(finalTopic.title, '并发后的新标题');
    assert.equal(finalTopic.status, 'SCHEDULED');
    assert.equal(finalTopic.presenter, '分享人');
    assert.equal(finalTopic.scheduledAt, scheduledAt);
    assert.equal(finalTopic.duration, 50);
    assert.equal(finalTopic.room, '并发测试会议室');

    await Promise.all([editingApp.close(), lifecycleApp.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  it('排序版本 CAS 阻止陈旧写并在成员变化后失效', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-order-cas-'));
    const databasePath = path.join(directory, 'shared.db');
    const firstApp = buildApp({ databasePath, seed: false, serveStatic: false });
    const secondApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await Promise.all([firstApp.ready(), secondApp.ready()]);
    for (const title of ['排序甲', '排序乙', '排序丙']) {
      await firstApp.inject({ method: 'POST', url: '/api/topics', payload: { title, summary: `${title}的简介`, proposer: '排序测试', tags: [] } });
    }
    const snapshot = await firstApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const ids = (snapshot.json() as { id: number }[]).map(({ id }) => id);
    const version = Number(snapshot.headers['x-order-version']);
    const firstOrder = [ids[1], ids[0], ids[2]];
    const secondOrder = [ids[0], ids[2], ids[1]];
    const [first, second] = await Promise.all([
      firstApp.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: firstOrder, baseVersion: version } }),
      secondApp.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: secondOrder, baseVersion: version } }),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [204, 409]);
    const winningOrder = first.statusCode === 204 ? firstOrder : secondOrder;
    const final = await firstApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.deepEqual((final.json() as { id: number }[]).map(({ id }) => id), winningOrder);
    assert.deepEqual((final.json() as { position: number }[]).map(({ position }) => position), [1, 2, 3]);

    const beforeCreateVersion = Number(final.headers['x-order-version']);
    await secondApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '新成员', summary: '创建后使旧排序版本失效。', proposer: '排序测试', tags: [] },
    });
    const staleAfterCreate = await firstApp.inject({
      method: 'POST', url: '/api/topics/reorder',
      payload: { orderedIds: winningOrder, baseVersion: beforeCreateVersion },
    });
    assert.equal(staleAfterCreate.statusCode, 409);

    const beforeDelete = await firstApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const beforeDeleteIds = (beforeDelete.json() as { id: number }[]).map(({ id }) => id);
    await secondApp.inject({ method: 'DELETE', url: `/api/topics/${beforeDeleteIds.at(-1)}` });
    const staleAfterDelete = await firstApp.inject({
      method: 'POST', url: '/api/topics/reorder',
      payload: { orderedIds: beforeDeleteIds, baseVersion: Number(beforeDelete.headers['x-order-version']) },
    });
    assert.equal(staleAfterDelete.statusCode, 409);
    const compacted = await firstApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.deepEqual((compacted.json() as { position: number }[]).map(({ position }) => position), [1, 2, 3]);

    await Promise.all([firstApp.close(), secondApp.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  it('列表与顺序版本来自同一个只读快照', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-read-snapshot-'));
    const databasePath = path.join(directory, 'shared.db');
    let pauseNextRead = false;
    let signalRowsRead!: () => void;
    let releaseRead!: () => void;
    const rowsRead = new Promise<void>((resolve) => { signalRowsRead = resolve; });
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readingApp = buildApp({
      databasePath,
      seed: false,
      serveStatic: false,
      afterTopicRowsRead: async () => {
        if (!pauseNextRead) return;
        pauseNextRead = false;
        signalRowsRead();
        await readReleased;
      },
    });
    const writingApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await Promise.all([readingApp.ready(), writingApp.ready()]);
    for (const title of ['快照甲', '快照乙', '快照丙']) {
      await writingApp.inject({ method: 'POST', url: '/api/topics', payload: { title, summary: `${title}的简介`, proposer: '快照测试', tags: [] } });
    }
    const before = await writingApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const oldIds = (before.json() as { id: number }[]).map(({ id }) => id);
    const oldVersion = Number(before.headers['x-order-version']);

    pauseNextRead = true;
    const pendingSnapshot = readingApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    await rowsRead;
    const newIds = [...oldIds].reverse();
    const concurrentReorder = await writingApp.inject({
      method: 'POST',
      url: '/api/topics/reorder',
      payload: { orderedIds: newIds, baseVersion: oldVersion },
    });
    assert.equal(concurrentReorder.statusCode, 204);
    releaseRead();

    const snapshot = await pendingSnapshot;
    assert.deepEqual((snapshot.json() as { id: number }[]).map(({ id }) => id), oldIds);
    assert.equal(Number(snapshot.headers['x-order-version']), oldVersion);
    const staleWrite = await readingApp.inject({
      method: 'POST',
      url: '/api/topics/reorder',
      payload: { orderedIds: [oldIds[1], oldIds[0], oldIds[2]], baseVersion: oldVersion },
    });
    assert.equal(staleWrite.statusCode, 409);
    const authoritative = await writingApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.deepEqual((authoritative.json() as { id: number }[]).map(({ id }) => id), newIds);

    await Promise.all([readingApp.close(), writingApp.close()]);
    await rm(directory, { recursive: true, force: true });
  });
});
