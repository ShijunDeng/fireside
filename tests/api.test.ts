import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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
});
