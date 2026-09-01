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
    const reversed = [...ids].reverse();
    const reordered = await app.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: reversed } });
    assert.equal(reordered.statusCode, 204);
    const after = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.deepEqual((after.json() as { id: number }[]).map(({ id }) => id), reversed);

    const incomplete = await app.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: reversed.slice(1) } });
    assert.equal(incomplete.statusCode, 400);
    const duplicate = await app.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: [reversed[0], reversed[0]] } });
    assert.equal(duplicate.statusCode, 400);
  });
});

describe('数据库兼容性与并发', () => {
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
});
