import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';

const ifMatch = (revision: number) => ({ 'if-match': `"${revision}"` });

const readTopic = async (instance: FastifyInstance, id: number) => {
  const response = await instance.inject({ method: 'GET', url: `/api/topics/${id}` });
  assert.equal(response.statusCode, 200);
  return response.json() as { id: number; revision: number; [key: string]: unknown };
};

const deleteTopicThroughLifecycle = async (instance: FastifyInstance, id: number) => {
  let topic = await readTopic(instance, id) as { id: number; revision: number; status: string; [key: string]: unknown };
  if (topic.status === 'ARCHIVED') {
    const unarchived = await instance.inject({ method: 'POST', url: `/api/topics/${id}/unarchive`, headers: ifMatch(topic.revision), payload: {} });
    assert.equal(unarchived.statusCode, 200);
    topic = unarchived.json();
  }
  if (topic.status === 'SCHEDULED') {
    const unscheduled = await instance.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, headers: ifMatch(topic.revision), payload: {} });
    assert.equal(unscheduled.statusCode, 200);
    topic = unscheduled.json();
  }
  assert.ok(topic.status === 'OPEN' || topic.status === 'CLAIMED');
  const deleted = await instance.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(topic.revision) });
  assert.equal(deleted.statusCode, 204);
  return deleted;
};

const issueSession = async (instance: FastifyInstance, writeKey: string, remoteAddress = '127.0.0.1') => {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/access/verify',
    headers: {
      'x-fireside-write-key': Buffer.from(writeKey, 'utf8').toString('base64url'),
      'x-fireside-write-key-encoding': 'base64url-utf8-v1',
    },
    remoteAddress,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = response.json() as { sessionToken: string; expiresAt: string };
  assert.match(body.sessionToken, /^v1\./);
  assert.equal(Number.isNaN(Date.parse(body.expiresAt)), false);
  return body;
};

const tamperSessionToken = (sessionToken: string) => {
  const segments = sessionToken.split('.');
  const mac = segments[4];
  segments[4] = `${mac.startsWith('A') ? 'B' : 'A'}${mac.slice(1)}`;
  return segments.join('.');
};

describe('围炉夜话 API', () => {
  let app: FastifyInstance;
  let appNow: Date | null = null;

  before(async () => {
    app = buildApp({ databasePath: ':memory:', seed: false, serveStatic: false, now: () => appNow ?? new Date() });
    await app.ready();
  });

  afterEach(() => { appNow = null; });

  after(async () => {
    await app.close();
  });

  it('返回健康状态', async () => {
    const releaseCommit = 'a'.repeat(40);
    const healthApp = buildApp({ databasePath: ':memory:', seed: false, serveStatic: false, releaseCommit });
    await healthApp.ready();
    const response = await healthApp.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
    assert.equal(response.json().releaseCommit, releaseCommit);
    await healthApp.close();
  });

  it('只用短期会话保护全部写操作、名单和真实会议入口', async () => {
    const writeKey = '松风明月共围炉';
    const protectedApp = buildApp({ databasePath: ':memory:', seed: false, serveStatic: false, writeKey });
    await protectedApp.ready();
    const publicAccess = await protectedApp.inject({ method: 'GET', url: '/api/access' });
    assert.deepEqual(publicAccess.json(), { enabled: true });
    assert.equal((await protectedApp.inject({ method: 'GET', url: '/api/topics' })).statusCode, 200);
    assert.equal((await protectedApp.inject({ method: 'GET', url: '/api/stats' })).statusCode, 200);
    const wrong = await protectedApp.inject({ method: 'POST', url: '/api/access/verify', headers: { 'x-fireside-write-key': 'wrong' } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().code, 'ACCESS_REQUIRED');
    assert.equal(wrong.headers['cache-control'], 'no-store');
    const issued = await issueSession(protectedApp, writeKey);
    const headers = { 'x-fireside-session': issued.sessionToken };
    const session = await protectedApp.inject({ method: 'GET', url: '/api/access/session', headers });
    assert.equal(session.statusCode, 200);
    assert.deepEqual(session.json(), { valid: true, expiresAt: issued.expiresAt });
    assert.equal(session.headers['cache-control'], 'no-store');

    const protectedRoutes = [
      { method: 'POST', url: '/api/topics' },
      { method: 'PATCH', url: '/api/topics/1' },
      { method: 'DELETE', url: '/api/topics/1' },
      { method: 'POST', url: '/api/topics/reorder' },
      { method: 'POST', url: '/api/topics/1/claim' },
      { method: 'POST', url: '/api/topics/1/release' },
      { method: 'POST', url: '/api/topics/1/schedule' },
      { method: 'POST', url: '/api/topics/1/unschedule' },
      { method: 'POST', url: '/api/topics/1/archive' },
      { method: 'POST', url: '/api/topics/1/unarchive' },
      { method: 'GET', url: '/api/topics/1/participants' },
      { method: 'POST', url: '/api/topics/1/participants' },
      { method: 'DELETE', url: '/api/topics/1/participants/1' },
      { method: 'GET', url: '/api/topics/1/meeting-access' },
      { method: 'GET', url: '/api/access/session' },
    ] as const;
    for (const route of protectedRoutes) {
      const response = await protectedApp.inject({ ...route, payload: ['POST', 'PATCH'].includes(route.method) ? {} : undefined });
      assert.equal(response.statusCode, 401, `${route.method} ${route.url} 必须先鉴权`);
      assert.equal(response.json().code, 'ACCESS_SESSION_REQUIRED');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    for (const route of protectedRoutes) {
      const response = await protectedApp.inject({
        ...route,
        headers,
        payload: ['POST', 'PATCH'].includes(route.method) ? {} : undefined,
      });
      assert.notEqual(response.statusCode, 401, `${route.method} ${route.url} 必须接受有效会话`);
    }

    const oldClient = await protectedApp.inject({
      method: 'POST', url: '/api/topics', headers: { 'x-fireside-write-key': writeKey },
      payload: { title: '旧客户端不能写入', summary: '原始口令不再被业务路由读取。', proposer: '旧客户端', tags: [] },
    });
    assert.equal(oldClient.statusCode, 401);
    assert.equal(oldClient.json().code, 'ACCESS_SESSION_REQUIRED');

    const legacyKey = 'legacy-ascii-key';
    const legacyApp = buildApp({ databasePath: ':memory:', seed: false, serveStatic: false, writeKey: legacyKey });
    await legacyApp.ready();
    assert.equal((await legacyApp.inject({
      method: 'POST', url: '/api/access/verify', headers: { 'x-fireside-write-key': legacyKey },
    })).statusCode, 200);
    assert.equal((await legacyApp.inject({
      method: 'POST', url: '/api/access/verify',
      headers: {
        'x-fireside-write-key': Buffer.from(legacyKey).toString('base64url'),
        'x-fireside-write-key-encoding': 'unknown-v2',
      },
    })).statusCode, 401);
    await legacyApp.close();

    const malformedBeforeAuth = await protectedApp.inject({
      method: 'POST', url: '/api/topics', headers: { 'content-type': 'application/json' }, payload: '{',
    });
    assert.equal(malformedBeforeAuth.statusCode, 401);
    assert.equal(malformedBeforeAuth.json().code, 'ACCESS_SESSION_REQUIRED');

    const created = await protectedApp.inject({
      method: 'POST', url: '/api/topics', headers,
      payload: { title: '受保护的线上议题', summary: '匿名响应不能泄露会议 secret。', proposer: '组织者', presenter: '组织者', tags: [] },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers['cache-control'], 'no-store');
    const id = created.json().id as number;
    const createdRevision = created.json().revision as number;
    const missingRevision = await protectedApp.inject({
      method: 'PATCH', url: `/api/topics/${id}`, headers, payload: { title: '不应写入' },
    });
    assert.equal(missingRevision.statusCode, 428);
    assert.equal(missingRevision.json().code, 'TOPIC_REVISION_REQUIRED');
    const secretMeeting = 'https://meet.example.test/team?passcode=top-secret';
    const scheduled = await protectedApp.inject({
      method: 'POST', url: `/api/topics/${id}/schedule`, headers: { ...headers, ...ifMatch(createdRevision) },
      payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 40, room: '三楼会议室', meetingUrl: secretMeeting },
    });
    assert.equal(scheduled.statusCode, 200);
    assert.equal(scheduled.json().meetingUrl, null);
    assert.equal(scheduled.json().hasMeetingUrl, true);
    const joined = await protectedApp.inject({ method: 'POST', url: `/api/topics/${id}/participants`, headers, payload: { name: '隐私参与者' } });
    assert.equal(joined.statusCode, 201);

    const idText = String(id);
    const encodedId = `%${idText.charCodeAt(0).toString(16)}${idText.slice(1)}`;
    const guardedReadVariants = [
      { method: 'GET', url: `/api/topics/${encodedId}/meeting-access` },
      { method: 'GET', url: `/api/topics/${id}/%70articipants` },
      { method: 'HEAD', url: `/api/topics/${id}/participants` },
      { method: 'HEAD', url: `/api/topics/${encodedId}/meeting-access` },
      { method: 'HEAD', url: '/api/access/session' },
    ] as const;
    for (const route of guardedReadVariants) {
      const rejected = await protectedApp.inject(route);
      assert.equal(rejected.statusCode, 401, `${route.method} ${route.url} 的编码或 HEAD 变体必须先鉴权`);
      assert.equal(rejected.headers['cache-control'], 'no-store');
      assert.equal(rejected.body.includes(secretMeeting), false);
      assert.equal(rejected.body.includes('隐私参与者'), false);
      if (route.method === 'GET') assert.equal(rejected.json().code, 'ACCESS_SESSION_REQUIRED');
      else assert.equal(rejected.body, '');

      const accepted = await protectedApp.inject({ ...route, headers });
      assert.equal(accepted.statusCode, 200, `${route.method} ${route.url} 的编码或 HEAD 变体必须接受有效会话`);
      assert.equal(accepted.headers['cache-control'], 'no-store');
      if (route.method === 'HEAD') assert.equal(accepted.body, '');
    }

    const publicTopics = await protectedApp.inject({ method: 'GET', url: '/api/topics' });
    assert.equal(publicTopics.body.includes('top-secret'), false);
    assert.equal(publicTopics.body.includes('隐私参与者'), false);
    const participants = await protectedApp.inject({ method: 'GET', url: `/api/topics/${id}/participants`, headers });
    assert.deepEqual((participants.json() as { name: string }[]).map(({ name }) => name), ['隐私参与者']);
    assert.equal(participants.headers['cache-control'], 'no-store');
    const meeting = await protectedApp.inject({ method: 'GET', url: `/api/topics/${id}/meeting-access`, headers });
    assert.equal(meeting.json().meetingUrl, secretMeeting);
    assert.equal(meeting.headers['cache-control'], 'no-store');

    const sensitiveTopic = await protectedApp.inject({
      method: 'POST', url: '/api/topics', headers,
      payload: { title: '敏感地点校验', summary: '在合法的待排期状态验证敏感地点。', proposer: '组织者', presenter: '组织者', tags: [] },
    });
    assert.equal(sensitiveTopic.statusCode, 201);
    const sensitiveRoom = await protectedApp.inject({
      method: 'POST', url: `/api/topics/${sensitiveTopic.json().id}/schedule`, headers: { ...headers, ...ifMatch(sensitiveTopic.json().revision) },
      payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 30, room: `线上入口：${secretMeeting}`, meetingUrl: '' },
    });
    assert.equal(sensitiveRoom.statusCode, 400);
    assert.equal(sensitiveRoom.json().code, 'SENSITIVE_ROOM_CONTENT');

    await protectedApp.close();
  });

  it('认证关闭时验证与会话校验保持 204 且业务开放', async () => {
    const openApp = buildApp({ databasePath: ':memory:', seed: false, serveStatic: false });
    await openApp.ready();
    const verify = await openApp.inject({ method: 'POST', url: '/api/access/verify' });
    const session = await openApp.inject({ method: 'GET', url: '/api/access/session' });
    assert.equal(verify.statusCode, 204);
    assert.equal(session.statusCode, 204);
    assert.equal(verify.headers['cache-control'], 'no-store');
    assert.equal(session.headers['cache-control'], 'no-store');
    assert.equal((await openApp.inject({
      method: 'POST', url: '/api/topics', payload: { title: '本地开放', summary: '无认证测试模式。', proposer: '测试', tags: [] },
    })).statusCode, 201);
    await openApp.close();
  });

  it('发布写许可关闭时全部业务 mutation 返回 503 且零副作用，公开读取和认证仍可用', async () => {
    const writeKey = 'release-barrier-test-write-key';
    let writesAllowed = false;
    const guardedApp = buildApp({
      databasePath: ':memory:',
      seed: false,
      serveStatic: false,
      writeKey,
      businessWritesAllowed: () => writesAllowed,
    });
    await guardedApp.ready();
    const issued = await issueSession(guardedApp, writeKey);
    const sessionHeaders = { 'x-fireside-session': issued.sessionToken };
    assert.equal((await guardedApp.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    assert.equal((await guardedApp.inject({ method: 'GET', url: '/api/topics' })).statusCode, 200);

    const rejectedWithoutSession = await guardedApp.inject({
      method: 'POST',
      url: '/api/topics',
      payload: { title: '不能写入', summary: '鉴权必须先于发布状态。', proposer: '测试', tags: [] },
    });
    assert.equal(rejectedWithoutSession.statusCode, 401);

    const mutations = [
      { method: 'POST', url: '/api/topics' },
      { method: 'PATCH', url: '/api/topics/1' },
      { method: 'DELETE', url: '/api/topics/1' },
      { method: 'POST', url: '/api/topics/reorder' },
      { method: 'POST', url: '/api/topics/1/claim' },
      { method: 'POST', url: '/api/topics/1/release' },
      { method: 'POST', url: '/api/topics/1/schedule' },
      { method: 'POST', url: '/api/topics/1/unschedule' },
      { method: 'POST', url: '/api/topics/1/archive' },
      { method: 'POST', url: '/api/topics/1/unarchive' },
      { method: 'POST', url: '/api/topics/1/participants' },
      { method: 'DELETE', url: '/api/topics/1/participants/1' },
    ] as const;
    for (const mutation of mutations) {
      const response = await guardedApp.inject({ ...mutation, headers: sessionHeaders });
      assert.equal(response.statusCode, 503, `${mutation.method} ${mutation.url}`);
      assert.equal(response.json().code, 'RELEASE_IN_PROGRESS');
      assert.equal(response.headers['retry-after'], '3');
    }
    const malformedDuringRelease = await guardedApp.inject({
      method: 'POST', url: '/api/topics', headers: { ...sessionHeaders, 'content-type': 'application/json' }, payload: '{',
    });
    assert.equal(malformedDuringRelease.statusCode, 503, '发布写屏障必须先于正文解析');
    assert.equal(malformedDuringRelease.json().code, 'RELEASE_IN_PROGRESS');
    assert.deepEqual((await guardedApp.inject({ method: 'GET', url: '/api/topics' })).json(), []);

    writesAllowed = true;
    const created = await guardedApp.inject({
      method: 'POST',
      url: '/api/topics',
      headers: sessionHeaders,
      payload: { title: '许可后重试', summary: '同一份草稿可以显式重试。', proposer: '测试', tags: [] },
    });
    assert.equal(created.statusCode, 201);
    await guardedApp.close();
  });

  it('将五类请求解析错误映射为稳定安全响应并保持全部业务数据不变', async () => {
    const writeKey = 'request-parser-contract-key';
    let logs = '';
    const parserApp = buildApp({
      databasePath: ':memory:', seed: false, serveStatic: false, writeKey,
      now: () => new Date('2026-09-02T10:00:00.000Z'),
      logger: true,
      loggerStream: { write: (message) => { logs += message; } },
    });
    await parserApp.ready();
    const issued = await issueSession(parserApp, writeKey);
    const headers = { 'x-fireside-session': issued.sessionToken };
    const created = await parserApp.inject({
      method: 'POST', url: '/api/topics', headers,
      payload: { title: '解析错误不变式', summary: '任何解析拒绝都不能改变议题。', proposer: '协议测试', presenter: '协议测试', tags: ['契约'] },
    });
    assert.equal(created.statusCode, 201);
    const scheduled = await parserApp.inject({
      method: 'POST', url: `/api/topics/${created.json().id}/schedule`, headers: { ...headers, ...ifMatch(created.json().revision) },
      payload: { scheduledAt: '2026-09-02T11:00:00.000Z', duration: 60, room: '围炉会议室', meetingUrl: '' },
    });
    assert.equal(scheduled.statusCode, 200);
    assert.equal((await parserApp.inject({
      method: 'POST', url: `/api/topics/${created.json().id}/participants`, headers, payload: { name: '报名伙伴' },
    })).statusCode, 201);

    const beforeTopics = await parserApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const beforeParticipants = await parserApp.inject({ method: 'GET', url: `/api/topics/${created.json().id}/participants`, headers });
    const baselineTopic = beforeTopics.json()[0] as { id: number; revision: number; [key: string]: unknown };
    const parserCases = [
      {
        name: '空 JSON',
        options: { headers: { ...headers, 'content-type': 'application/json' }, payload: '' },
        status: 400, code: 'INVALID_JSON_BODY', message: '提交内容不是有效的 JSON，请检查后重试',
      },
      {
        name: '畸形 JSON',
        options: { headers: { ...headers, 'content-type': 'application/json' }, payload: '{' },
        status: 400, code: 'INVALID_JSON_BODY', message: '提交内容不是有效的 JSON，请检查后重试',
      },
      {
        name: '错误媒体类型',
        options: { headers: { ...headers, 'content-type': 'application/xml' }, payload: '<topic />' },
        status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: '提交格式不受支持，请使用 JSON',
      },
      {
        name: '带长度正文超过 1 MiB',
        options: { headers: { ...headers, 'content-type': 'application/json' }, payload: `"${'a'.repeat(1024 * 1024 - 1)}"` },
        status: 413, code: 'REQUEST_BODY_TOO_LARGE', message: '提交内容过大，请精简后重试',
      },
      {
        name: '预声明正文超过 1 MiB',
        options: { headers: { ...headers, 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) }, payload: '{}' },
        status: 413, code: 'REQUEST_BODY_TOO_LARGE', message: '提交内容过大，请精简后重试',
      },
      {
        name: '正文长度不一致',
        options: { headers: { ...headers, 'content-type': 'application/json', 'content-length': '20' }, payload: '{}' },
        status: 400, code: 'INVALID_REQUEST_BODY', message: '请求内容不完整，请重新提交',
      },
    ] as const;
    for (const parserCase of parserCases) {
      const response = await parserApp.inject({ method: 'POST', url: '/api/topics', ...parserCase.options });
      assert.equal(response.statusCode, parserCase.status, parserCase.name);
      assert.deepEqual(response.json(), { code: parserCase.code, message: parserCase.message }, parserCase.name);
      assert.equal(response.headers['cache-control'], 'no-store', parserCase.name);
    }

    const exactLimit = await parserApp.inject({
      method: 'POST', url: '/api/topics',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: `"${'a'.repeat(1024 * 1024 - 2)}"`,
    });
    assert.equal(exactLimit.statusCode, 400, '恰好 1 MiB 应进入业务校验而不是 413');
    assert.notEqual(exactLimit.json().code, 'REQUEST_BODY_TOO_LARGE');

    for (const options of [
      { headers: { 'content-type': 'application/json' }, payload: '{' },
      { headers: { 'content-type': 'application/xml' }, payload: '<topic />' },
      { headers: { 'content-type': 'application/json' }, payload: `"${'a'.repeat(1024 * 1024)}"` },
    ]) {
      const response = await parserApp.inject({ method: 'POST', url: '/api/topics', ...options });
      assert.equal(response.statusCode, 401, '会话认证必须先于正文解析');
      assert.equal(response.json().code, 'ACCESS_SESSION_REQUIRED');
    }

    for (const revisionHeaders of [{}, { 'if-match': 'not-an-etag' }]) {
      const response = await parserApp.inject({
        method: 'PATCH', url: `/api/topics/${created.json().id}`,
        headers: { ...headers, ...revisionHeaders, 'content-type': 'application/json' }, payload: '{',
      });
      assert.equal(response.statusCode, 400, '正文解析必须先于 If-Match');
      assert.equal(response.json().code, 'INVALID_JSON_BODY');
    }

    const afterParserTopics = await parserApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const afterParserParticipants = await parserApp.inject({ method: 'GET', url: `/api/topics/${created.json().id}/participants`, headers });
    assert.equal(afterParserTopics.body, beforeTopics.body);
    assert.equal(afterParserTopics.headers['x-order-version'], beforeTopics.headers['x-order-version']);
    assert.equal(afterParserParticipants.body, beforeParticipants.body);

    const disposable = await parserApp.inject({
      method: 'POST', url: '/api/topics', headers,
      payload: { title: '可安全删除的临时议题', summary: '验证 DELETE 不应错误携带 JSON 类型。', proposer: '协议测试', tags: [] },
    });
    const malformedDelete = await parserApp.inject({
      method: 'DELETE', url: `/api/topics/${disposable.json().id}`,
      headers: { ...headers, ...ifMatch(disposable.json().revision), 'content-type': 'application/json' }, payload: '',
    });
    assert.equal(malformedDelete.statusCode, 400);
    assert.equal(malformedDelete.json().code, 'INVALID_JSON_BODY');
    assert.equal((await readTopic(parserApp, disposable.json().id)).revision, disposable.json().revision);
    assert.equal((await parserApp.inject({
      method: 'DELETE', url: `/api/topics/${disposable.json().id}`,
      headers: { ...headers, ...ifMatch(disposable.json().revision) },
    })).statusCode, 204);

    assert.deepEqual(await readTopic(parserApp, created.json().id), baselineTopic);
    assert.equal((await parserApp.inject({ method: 'GET', url: `/api/topics/${created.json().id}/participants`, headers })).body, beforeParticipants.body);
    assert.doesNotMatch(logs, /"level":50.*FST_ERR_CTP/, '预期客户端错误不得写 error 级日志');
    await parserApp.close();
  });

  it('在正文解析前执行 verify 限流且坏正文不形成口令 oracle 或失败计数旁路', async () => {
    let nowMs = Date.parse('2026-09-02T10:00:00.000Z');
    const writeKey = 'verify-parser-priority-key';
    const verifyApp = buildApp({
      databasePath: ':memory:', seed: false, serveStatic: false, writeKey,
      now: () => new Date(nowMs),
      authRateLimit: { windowMs: 60_000, perSourceLimit: 2, globalLimit: 20 },
    });
    await verifyApp.ready();
    const source = '203.0.113.90';
    const malformedBodies = await Promise.all([
      { 'x-fireside-write-key': writeKey },
      { 'x-fireside-write-key': 'wrong-candidate' },
      {},
    ].map((candidateHeaders) => verifyApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: source,
      headers: { ...candidateHeaders, 'content-type': 'application/json' }, payload: '{',
    })));
    for (const response of malformedBodies) {
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { code: 'INVALID_JSON_BODY', message: '提交内容不是有效的 JSON，请检查后重试' });
      assert.equal(response.headers['cache-control'], 'no-store');
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await verifyApp.inject({
        method: 'POST', url: '/api/access/verify', remoteAddress: source,
        headers: { 'x-fireside-write-key': `normal-wrong-${attempt}` },
      });
      assert.equal(failed.statusCode, 401, '坏正文不得提前消耗口令失败桶');
    }
    const blocked = await verifyApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: source,
      headers: { 'x-fireside-write-key': writeKey, 'content-type': 'application/json' },
      payload: `"${'a'.repeat(1024 * 1024)}"`,
    });
    assert.equal(blocked.statusCode, 429, '已限流来源必须在超限正文解析前拒绝');
    assert.equal(blocked.json().code, 'ACCESS_RATE_LIMITED');
    assert.equal(blocked.headers['retry-after'], '60');
    assert.equal(blocked.headers['cache-control'], 'no-store');

    nowMs += 60_000;
    assert.equal((await verifyApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: source,
      headers: { 'x-fireside-write-key': writeKey },
    })).statusCode, 200, '窗口恢复后正确口令应正常签发会话');
    await verifyApp.close();
  });

  it('真实 HTTP 监听稳定拒绝解析错误与提前断开的正文并保持健康', async () => {
    const writeKey = 'real-http-parser-key';
    const httpApp = buildApp({ databasePath: ':memory:', seed: false, serveStatic: false, writeKey });
    await httpApp.listen({ host: '127.0.0.1', port: 0 });
    const address = httpApp.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const issued = await issueSession(httpApp, writeKey);
    const baseline = (await httpApp.inject({ method: 'GET', url: '/api/topics?sort=manual' })).body;
    const cases = [
      { body: '', type: 'application/json', status: 400, code: 'INVALID_JSON_BODY' },
      { body: '{', type: 'application/json', status: 400, code: 'INVALID_JSON_BODY' },
      { body: '<topic />', type: 'application/xml', status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
      { body: `"${'a'.repeat(1024 * 1024 - 1)}"`, type: 'application/json', status: 413, code: 'REQUEST_BODY_TOO_LARGE' },
    ] as const;
    for (const parserCase of cases) {
      const response = await fetch(`${origin}/api/topics`, {
        method: 'POST',
        headers: { 'X-Fireside-Session': issued.sessionToken, 'Content-Type': parserCase.type },
        body: parserCase.body,
      });
      assert.equal(response.status, parserCase.status);
      assert.equal((await response.json() as { code: string }).code, parserCase.code);
    }

    const chunkedResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${origin}/api/topics`, {
        method: 'POST',
        headers: { 'X-Fireside-Session': issued.sessionToken, 'Content-Type': 'application/json' },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.on('error', reject);
      for (let chunk = 0; chunk < 17; chunk += 1) request.write('a'.repeat(64 * 1024));
      request.end();
    });
    assert.equal(chunkedResponse.status, 413, '无 Content-Length 的 chunked 正文越界也必须拒绝');
    assert.equal((JSON.parse(chunkedResponse.body) as { code: string }).code, 'REQUEST_BODY_TOO_LARGE');

    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: address.port });
      let response = '';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      const timer = setTimeout(() => {
        socket.destroy();
        finish();
      }, 2_000);
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write([
          'POST /api/topics HTTP/1.1',
          `Host: 127.0.0.1:${address.port}`,
          `X-Fireside-Session: ${issued.sessionToken}`,
          'Content-Type: application/json',
          'Content-Length: 100',
          'Connection: close',
          '',
          '{',
        ].join('\r\n'));
        socket.end();
      });
      socket.on('data', (chunk) => { response += chunk; });
      socket.on('end', () => { clearTimeout(timer); finish(); });
      socket.on('close', () => { clearTimeout(timer); finish(); });
      socket.on('error', (error) => {
        clearTimeout(timer);
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') finish();
        else reject(error);
      });
    });
    assert.ok(rawResponse === '' || /^HTTP\/1\.1 400\b/.test(rawResponse), '提前 EOF 只能安全 400 或关闭连接');
    assert.equal((await httpApp.inject({ method: 'GET', url: '/api/topics?sort=manual' })).body, baseline);
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    await httpApp.close();
  });

  it('未知内部异常保持安全 500、记录错误且不改变议题', async () => {
    const writeKey = 'internal-error-log-key';
    const internalMessage = 'internal-update-sentinel';
    let logs = '';
    const internalApp = buildApp({
      databasePath: ':memory:', seed: false, serveStatic: false, writeKey,
      beforeTopicUpdate: async () => { throw new Error(internalMessage); },
      logger: true,
      loggerStream: { write: (message) => { logs += message; } },
    });
    await internalApp.ready();
    const issued = await issueSession(internalApp, writeKey);
    const headers = { 'x-fireside-session': issued.sessionToken };
    const created = await internalApp.inject({
      method: 'POST', url: '/api/topics', headers,
      payload: { title: '内部异常基线', summary: '失败响应不能泄露内部信息。', proposer: '协议测试', tags: [] },
    });
    const before = await readTopic(internalApp, created.json().id);
    const rejected = await internalApp.inject({
      method: 'PATCH', url: `/api/topics/${created.json().id}`,
      headers: { ...headers, ...ifMatch(created.json().revision) }, payload: { title: '不应写入的标题' },
    });
    assert.equal(rejected.statusCode, 500);
    assert.deepEqual(rejected.json(), { message: '炉火晃了一下，请稍后再试' });
    assert.doesNotMatch(rejected.body, new RegExp(`${internalMessage}|${writeKey}|不应写入的标题`));
    assert.doesNotMatch(rejected.body, new RegExp(issued.sessionToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(logs, /internal-update-sentinel/);
    assert.doesNotMatch(logs, new RegExp(writeKey));
    assert.doesNotMatch(logs, new RegExp(issued.sessionToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(await readTopic(internalApp, created.json().id), before);
    await internalApp.close();
  });

  it('按 TCP 来源和全局滑动窗口限制口令验证且忽略转发头', async () => {
    let nowMs = Date.parse('2026-09-02T10:00:00.000Z');
    const writeKey = 'rate-limit-test-write-key';
    const limitedApp = buildApp({
      databasePath: ':memory:', seed: false, serveStatic: false, writeKey,
      now: () => new Date(nowMs),
      authRateLimit: { windowMs: 60_000, perSourceLimit: 3, globalLimit: 20 },
    });
    await limitedApp.ready();
    const source = '203.0.113.10';
    const preissued = await issueSession(limitedApp, writeKey, source);
    const wrongCandidates: Array<{ value?: string; encoding?: string }> = [
      {},
      { value: '====', encoding: 'base64url-utf8-v1' },
      { value: 'wrong' },
    ];
    for (let index = 0; index < wrongCandidates.length; index += 1) {
      const candidate = wrongCandidates[index];
      const failed = await limitedApp.inject({
        method: 'POST', url: '/api/access/verify', remoteAddress: source,
        headers: {
          ...(candidate.value === undefined ? {} : { 'x-fireside-write-key': candidate.value }),
          ...(candidate.encoding === undefined ? {} : { 'x-fireside-write-key-encoding': candidate.encoding }),
          'x-forwarded-for': `198.51.100.${index + 1}`,
          forwarded: `for=192.0.2.${index + 1}`,
          'x-real-ip': `192.0.2.${index + 10}`,
        },
      });
      assert.equal(failed.statusCode, 401);
    }
    const blocked = await limitedApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: source,
      headers: { 'x-fireside-write-key': writeKey, 'x-forwarded-for': '198.51.100.250' },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().code, 'ACCESS_RATE_LIMITED');
    assert.equal(blocked.headers['retry-after'], '60');
    assert.equal(blocked.headers['cache-control'], 'no-store');
    const businessDuringBlock = await limitedApp.inject({
      method: 'POST', url: '/api/topics', remoteAddress: source,
      headers: { 'x-fireside-session': preissued.sessionToken },
      payload: { title: '已解锁会话不受猜测限流影响', summary: '限流只约束新会话签发。', proposer: '测试', tags: [] },
    });
    assert.equal(businessDuringBlock.statusCode, 201);

    const isolated = await limitedApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: '203.0.113.11',
      headers: { 'x-fireside-write-key': 'wrong-isolated' },
    });
    assert.equal(isolated.statusCode, 401);
    nowMs += 59_000;
    const almostRecovered = await limitedApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: source,
      headers: { 'x-fireside-write-key': writeKey },
    });
    assert.equal(almostRecovered.statusCode, 429);
    assert.equal(almostRecovered.headers['retry-after'], '1');
    nowMs += 1_000;
    assert.equal((await limitedApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: source,
      headers: { 'x-fireside-write-key': writeKey },
    })).statusCode, 200);
    await limitedApp.close();

    const concurrentApp = buildApp({
      databasePath: ':memory:', seed: false, serveStatic: false, writeKey,
      now: () => new Date(nowMs), authRateLimit: { perSourceLimit: 10, globalLimit: 200 },
    });
    await concurrentApp.ready();
    const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) => concurrentApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: '::ffff:203.0.113.20',
      headers: { 'x-fireside-write-key': `parallel-wrong-${index}` },
    })));
    assert.equal(concurrent.filter(({ statusCode }) => statusCode === 401).length, 10);
    assert.equal(concurrent.filter(({ statusCode }) => statusCode === 429).length, 2);
    assert.equal((await concurrentApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: '203.0.113.20',
      headers: { 'x-fireside-write-key': writeKey },
    })).statusCode, 429, 'IPv4-mapped IPv6 与 IPv4 必须共用来源桶');
    await concurrentApp.close();

    const globalApp = buildApp({
      databasePath: ':memory:', seed: false, serveStatic: false, writeKey,
      now: () => new Date(nowMs), authRateLimit: { perSourceLimit: 10, globalLimit: 3 },
    });
    await globalApp.ready();
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await globalApp.inject({
        method: 'POST', url: '/api/access/verify', remoteAddress: `198.51.100.${index + 1}`,
        headers: { 'x-fireside-write-key': 'wrong-global' },
      })).statusCode, 401);
    }
    const globalBlocked = await globalApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: '198.51.100.99',
      headers: { 'x-fireside-write-key': writeKey },
    });
    assert.equal(globalBlocked.statusCode, 429);
    assert.equal(globalBlocked.headers['retry-after'], '60');
    await globalApp.close();

    const resetOptions = {
      databasePath: ':memory:' as const, seed: false, serveStatic: false, writeKey,
      now: () => new Date(nowMs), authRateLimit: { perSourceLimit: 1, globalLimit: 20 },
    };
    const beforeRestart = buildApp(resetOptions);
    await beforeRestart.ready();
    assert.equal((await beforeRestart.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: '192.0.2.80',
      headers: { 'x-fireside-write-key': 'wrong-before-restart' },
    })).statusCode, 401);
    assert.equal((await beforeRestart.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: '192.0.2.80',
      headers: { 'x-fireside-write-key': writeKey },
    })).statusCode, 429);
    await beforeRestart.close();
    const afterRestart = buildApp(resetOptions);
    await afterRestart.ready();
    assert.equal((await afterRestart.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: '192.0.2.80',
      headers: { 'x-fireside-write-key': writeKey },
    })).statusCode, 200, '进程内限流桶必须随应用重启清空');
    await afterRestart.close();
  });

  it('会话令牌到期、篡改或畸形时统一拒绝且认证先于业务校验', async () => {
    let nowMs = Date.parse('2026-09-02T10:15:20.777Z');
    const writeKey = 'session-expiry-test-write-key';
    const sessionApp = buildApp({
      databasePath: ':memory:', seed: false, serveStatic: false, writeKey,
      now: () => new Date(nowMs),
    });
    await sessionApp.ready();
    const issued = await issueSession(sessionApp, writeKey);
    assert.equal(issued.expiresAt, '2026-09-02T18:15:20.000Z');

    const tamperedToken = tamperSessionToken(issued.sessionToken);
    const invalidTokens = [undefined, '', 'not-a-session', tamperedToken];
    for (const token of invalidTokens) {
      const response = await sessionApp.inject({
        method: 'PATCH', url: '/api/topics/999999',
        headers: {
          ...(token === undefined ? {} : { 'x-fireside-session': token }),
          'if-match': 'not-a-revision',
          'content-type': 'application/json',
        },
        payload: '{',
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, 'ACCESS_SESSION_REQUIRED');
      assert.equal(response.headers['cache-control'], 'no-store');
    }

    const validBusinessError = await sessionApp.inject({
      method: 'PATCH', url: '/api/topics/999999',
      headers: { 'x-fireside-session': issued.sessionToken, 'if-match': 'not-a-revision' }, payload: { title: '不会写入' },
    });
    assert.equal(validBusinessError.statusCode, 400);
    assert.equal(validBusinessError.json().code, 'INVALID_TOPIC_REVISION');

    nowMs = Date.parse(issued.expiresAt);
    const expired = await sessionApp.inject({
      method: 'GET', url: '/api/access/session', headers: { 'x-fireside-session': issued.sessionToken },
    });
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.json().code, 'ACCESS_SESSION_REQUIRED');
    await sessionApp.close();
  });

  it('认证拒绝与限流不改变议题、排序或名单且响应和日志不泄密', async () => {
    const writeKey = 'never-log-this-write-key';
    const meetingUrl = 'https://meet.example.test/private?pwd=never-log-meeting';
    const participantName = '永不出现在拒绝响应的参与者';
    let logs = '';
    const protectedApp = buildApp({
      databasePath: ':memory:', seed: false, serveStatic: false, writeKey,
      now: () => new Date('2026-09-02T10:00:00.000Z'),
      authRateLimit: { perSourceLimit: 2, globalLimit: 20 },
      logger: true,
      loggerStream: { write: (message) => { logs += message; } },
    });
    await protectedApp.ready();
    const issued = await issueSession(protectedApp, writeKey);
    const headers = { 'x-fireside-session': issued.sessionToken };
    const created = await protectedApp.inject({
      method: 'POST', url: '/api/topics', headers,
      payload: { title: '认证不变式', summary: '拒绝路径不能改变业务数据。', proposer: '安全测试', presenter: '安全测试', tags: [] },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as number;
    const scheduled = await protectedApp.inject({
      method: 'POST', url: `/api/topics/${id}/schedule`, headers: { ...headers, ...ifMatch(created.json().revision) },
      payload: { scheduledAt: '2026-09-02T11:00:00.000Z', duration: 60, room: '保密会议室', meetingUrl },
    });
    assert.equal(scheduled.statusCode, 200);
    const joined = await protectedApp.inject({
      method: 'POST', url: `/api/topics/${id}/participants`, headers, payload: { name: participantName },
    });
    assert.equal(joined.statusCode, 201);

    const beforeTopics = await protectedApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const beforeParticipants = await protectedApp.inject({ method: 'GET', url: `/api/topics/${id}/participants`, headers });
    const beforeTopicBody = beforeTopics.body;
    const beforeOrderVersion = beforeTopics.headers['x-order-version'];
    const beforeParticipantBody = beforeParticipants.body;
    const invalidSession = tamperSessionToken(issued.sessionToken);
    const rejected = [
      await protectedApp.inject({
        method: 'POST', url: '/api/topics', remoteAddress: '203.0.113.77', headers: { 'x-fireside-write-key': writeKey },
        payload: { title: '不能创建', summary: '旧头无效。', proposer: '旧客户端', tags: [] },
      }),
      await protectedApp.inject({
        method: 'PATCH', url: `/api/topics/${id}`, headers: { 'x-fireside-session': invalidSession, ...ifMatch(scheduled.json().revision) },
        payload: { title: '不能编辑' },
      }),
      await protectedApp.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: { 'x-fireside-session': invalidSession, ...ifMatch(scheduled.json().revision) } }),
      await protectedApp.inject({ method: 'POST', url: '/api/topics/reorder', headers: { 'x-fireside-session': invalidSession }, payload: { orderedIds: [id], baseVersion: Number(beforeOrderVersion) } }),
      await protectedApp.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, headers: { 'x-fireside-session': invalidSession, ...ifMatch(scheduled.json().revision) } }),
      await protectedApp.inject({ method: 'POST', url: `/api/topics/${id}/participants`, headers: { 'x-fireside-session': invalidSession }, payload: { name: '不能报名' } }),
      await protectedApp.inject({ method: 'DELETE', url: `/api/topics/${id}/participants/${joined.json().id}`, headers: { 'x-fireside-session': invalidSession } }),
      await protectedApp.inject({ method: 'GET', url: `/api/topics/${id}/participants`, headers: { 'x-fireside-session': invalidSession } }),
      await protectedApp.inject({ method: 'GET', url: `/api/topics/${id}/meeting-access`, headers: { 'x-fireside-session': invalidSession } }),
    ];
    for (const response of rejected) {
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, 'ACCESS_SESSION_REQUIRED');
      assert.equal(response.body.includes(writeKey), false);
      assert.equal(response.body.includes(issued.sessionToken), false);
      assert.equal(response.body.includes(meetingUrl), false);
      assert.equal(response.body.includes(participantName), false);
    }

    for (let index = 0; index < 2; index += 1) {
      assert.equal((await protectedApp.inject({
        method: 'POST', url: '/api/access/verify', remoteAddress: '203.0.113.77',
        headers: { 'x-fireside-write-key': `wrong-after-old-business-${index}` },
      })).statusCode, 401, '旧业务头拒绝不得消耗 verify 来源桶');
    }
    const rateLimited = await protectedApp.inject({
      method: 'POST', url: '/api/access/verify', remoteAddress: '203.0.113.77',
      headers: { 'x-fireside-write-key': writeKey },
    });
    assert.equal(rateLimited.statusCode, 429);
    assert.equal(rateLimited.body.includes(writeKey), false);
    assert.equal(rateLimited.body.includes(issued.sessionToken), false);

    const afterTopics = await protectedApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const afterParticipants = await protectedApp.inject({ method: 'GET', url: `/api/topics/${id}/participants`, headers });
    assert.equal(afterTopics.body, beforeTopicBody);
    assert.equal(afterTopics.headers['x-order-version'], beforeOrderVersion);
    assert.equal(afterParticipants.body, beforeParticipantBody);
    await protectedApp.close();
    assert.equal(logs.includes(writeKey), false);
    assert.equal(logs.includes(issued.sessionToken), false);
    assert.equal(logs.includes(meetingUrl), false);
    assert.equal(logs.includes(participantName), false);
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
    assert.equal(created.json().revision, 1);
    const id = created.json().id as number;

    const claimed = await app.inject({ method: 'POST', url: `/api/topics/${id}/claim`, headers: ifMatch(created.json().revision), payload: { presenter: '分享者' } });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.json().status, 'CLAIMED');
    assert.equal(claimed.json().presenter, '分享者');
    assert.equal(claimed.json().revision, 2);

    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await app.inject({
      method: 'POST',
      url: `/api/topics/${id}/schedule`,
      headers: ifMatch(claimed.json().revision),
      payload: { scheduledAt, duration: 45, room: '测试会议室' },
    });
    assert.equal(scheduled.statusCode, 200);
    assert.equal(scheduled.json().status, 'SCHEDULED');
    assert.equal(scheduled.json().duration, 45);
    assert.equal(scheduled.json().revision, 3);

    appNow = new Date(new Date(scheduledAt).getTime() + 45 * 60_000);
    const archived = await app.inject({
      method: 'POST',
      url: `/api/topics/${id}/archive`,
      headers: ifMatch(scheduled.json().revision),
      payload: { takeaway: '测试覆盖完整流程。', materialUrl: 'https://example.com/notes' },
    });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().status, 'ARCHIVED');
    assert.equal(archived.json().takeaway, '测试覆盖完整流程。');
    assert.equal(archived.json().revision, 4);

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
    const claim = await app.inject({ method: 'POST', url: `/api/topics/${firstId}/claim`, headers: ifMatch(first.json().revision), payload: { presenter: 'B' } });
    assert.equal(claim.statusCode, 200);
    const duplicate = await app.inject({ method: 'POST', url: `/api/topics/${firstId}/claim`, headers: ifMatch(claim.json().revision), payload: { presenter: 'C' } });
    assert.equal(duplicate.statusCode, 409);

    const second = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '越级排期', summary: '尚未认领时不能排期。', proposer: 'A', tags: [] },
    });
    const invalidSchedule = await app.inject({
      method: 'POST', url: `/api/topics/${second.json().id}/schedule`,
      headers: ifMatch(second.json().revision),
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

    const released = await app.inject({ method: 'POST', url: `/api/topics/${id}/release`, headers: ifMatch(created.json().revision), payload: {} });
    assert.equal(released.statusCode, 200);
    assert.equal(released.json().status, 'OPEN');
    assert.equal(released.json().presenter, null);
    assert.equal(released.json().revision, 2);
    const duplicateRelease = await app.inject({ method: 'POST', url: `/api/topics/${id}/release`, headers: ifMatch(released.json().revision), payload: {} });
    assert.equal(duplicateRelease.statusCode, 409);

    const reclaimed = await app.inject({ method: 'POST', url: `/api/topics/${id}/claim`, headers: ifMatch(released.json().revision), payload: { presenter: '接力者' } });
    assert.equal(reclaimed.statusCode, 200);
    assert.equal(reclaimed.json().revision, 3);
    const scheduledAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const scheduled = await app.inject({
      method: 'POST',
      url: `/api/topics/${id}/schedule`,
      headers: ifMatch(reclaimed.json().revision),
      payload: { scheduledAt, duration: 50, room: '纠错会议室' },
    });
    assert.equal(scheduled.statusCode, 200);
    assert.equal(scheduled.json().revision, 4);
    appNow = new Date(new Date(scheduledAt).getTime() + 50 * 60_000);
    const archived = await app.inject({
      method: 'POST',
      url: `/api/topics/${id}/archive`,
      headers: ifMatch(scheduled.json().revision),
      payload: { takeaway: '这段内容将在撤销归档时清空。', materialUrl: 'https://example.com/flow' },
    });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().revision, 5);

    const unarchived = await app.inject({ method: 'POST', url: `/api/topics/${id}/unarchive`, headers: ifMatch(archived.json().revision), payload: {} });
    assert.equal(unarchived.statusCode, 200);
    assert.equal(unarchived.json().status, 'SCHEDULED');
    assert.equal(unarchived.json().scheduledAt, scheduledAt);
    assert.equal(unarchived.json().presenter, '接力者');
    assert.equal(unarchived.json().takeaway, null);
    assert.equal(unarchived.json().materialUrl, null);
    assert.equal(unarchived.json().archivedAt, null);
    assert.equal(unarchived.json().revision, 6);

    const unscheduled = await app.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, headers: ifMatch(unarchived.json().revision), payload: {} });
    assert.equal(unscheduled.statusCode, 200);
    assert.equal(unscheduled.json().status, 'CLAIMED');
    assert.equal(unscheduled.json().presenter, '接力者');
    assert.equal(unscheduled.json().scheduledAt, null);
    assert.equal(unscheduled.json().duration, null);
    assert.equal(unscheduled.json().room, null);
    assert.equal(unscheduled.json().revision, 7);
    const duplicateUnschedule = await app.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, headers: ifMatch(unscheduled.json().revision), payload: {} });
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
      headers: ifMatch(created.json().revision),
      payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 60, room: '线上会议', meetingUrl },
    });
    assert.equal(scheduled.statusCode, 200);
    assert.equal(scheduled.json().meetingUrl, null);
    assert.equal(scheduled.json().hasMeetingUrl, true);
    const meetingAccess = await app.inject({ method: 'GET', url: `/api/topics/${id}/meeting-access` });
    assert.equal(meetingAccess.json().meetingUrl, meetingUrl);

    const firstJoin = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: 'Alice' } });
    assert.equal(firstJoin.statusCode, 201);
    const duplicateJoin = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: '  alice  ' } });
    assert.equal(duplicateJoin.statusCode, 409);
    assert.equal(duplicateJoin.json().code, 'PARTICIPANT_DUPLICATE');
    const secondJoin = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: '小林' } });
    assert.equal(secondJoin.statusCode, 201);
    const participants = await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` });
    assert.deepEqual((participants.json() as { name: string }[]).map(({ name }) => name), ['Alice', '小林']);
    const topics = await app.inject({ method: 'GET', url: '/api/topics' });
    const topic = (topics.json() as { id: number; participantCount: number }[]).find((item) => item.id === id);
    assert.equal(topic?.participantCount, 2);

    const leftUpcoming = await app.inject({ method: 'DELETE', url: `/api/topics/${id}/participants/${firstJoin.json().id}` });
    assert.equal(leftUpcoming.statusCode, 204);
    const afterUpcomingLeave = await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` });
    assert.deepEqual((afterUpcomingLeave.json() as { name: string }[]).map(({ name }) => name), ['小林']);

    const latestBeforeArchive = await readTopic(app, id);
    appNow = new Date(new Date(String(latestBeforeArchive.scheduledAt)).getTime() + Number(latestBeforeArchive.duration) * 60_000);
    const archived = await app.inject({
      method: 'POST', url: `/api/topics/${id}/archive`, headers: ifMatch(latestBeforeArchive.revision),
      payload: { takeaway: '参会闭环完成。', materialUrl: '' },
    });
    assert.equal(archived.statusCode, 200);
    const joinArchived = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: '迟到者' } });
    assert.equal(joinArchived.statusCode, 409);
    assert.equal(joinArchived.json().code, 'TOPIC_STATE_CONFLICT');
    const leaveArchived = await app.inject({ method: 'DELETE', url: `/api/topics/${id}/participants/${secondJoin.json().id}` });
    assert.equal(leaveArchived.statusCode, 409);
    const archivedMeeting = await app.inject({ method: 'GET', url: `/api/topics/${id}/meeting-access` });
    assert.equal(archivedMeeting.statusCode, 409);
    assert.equal(archivedMeeting.json().code, 'ACTIVITY_TIME_CONFLICT');
    assert.equal(archivedMeeting.body.includes(meetingUrl), false);

    const unarchived = await app.inject({ method: 'POST', url: `/api/topics/${id}/unarchive`, headers: ifMatch(archived.json().revision), payload: {} });
    assert.equal(unarchived.statusCode, 200);
    const frozenLeave = await app.inject({ method: 'DELETE', url: `/api/topics/${id}/participants/${secondJoin.json().id}` });
    assert.equal(frozenLeave.statusCode, 409);
    assert.equal(frozenLeave.json().code, 'ACTIVITY_TIME_CONFLICT');
    const afterFrozenLeave = await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` });
    assert.deepEqual((afterFrozenLeave.json() as { name: string }[]).map(({ name }) => name), ['小林']);

    const unscheduled = await app.inject({
      method: 'POST', url: `/api/topics/${id}/unschedule`,
      headers: ifMatch((await readTopic(app, id)).revision), payload: {},
    });
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
      headers: ifMatch(invalidUrlTopic.json().revision),
      payload: { scheduledAt: new Date().toISOString(), duration: 30, room: '线上', meetingUrl: 'javascript:alert(1)' },
    });
    assert.equal(invalidUrl.statusCode, 400);
  });

  it('以权威时钟精确执行活动阶段动作矩阵且拒绝路径不改变数据', async () => {
    let clock = new Date('2030-01-01T10:00:00.000Z');
    const phaseApp = buildApp({ databasePath: ':memory:', seed: false, serveStatic: false, now: () => clock });
    await phaseApp.ready();
    const start = Date.parse('2030-01-01T11:00:00.000Z');
    const duration = 40;
    const end = start + duration * 60_000;
    const meetingSecret = 'https://meet.example.test/phase?token=never-return-after-end';

    const createScheduled = async (title: string) => {
      const created = await phaseApp.inject({
        method: 'POST', url: '/api/topics',
        payload: { title, summary: '验证活动阶段边界。', proposer: '时间测试', presenter: '时间测试', tags: [] },
      });
      const scheduled = await phaseApp.inject({
        method: 'POST', url: `/api/topics/${created.json().id}/schedule`, headers: ifMatch(created.json().revision),
        payload: { scheduledAt: new Date(start).toISOString(), duration, room: '阶段测试会议室', meetingUrl: meetingSecret },
      });
      assert.equal(scheduled.statusCode, 200);
      return scheduled.json() as { id: number; revision: number; scheduledAt: string; duration: number };
    };

    const main = await createScheduled('阶段主议题');
    const reset = await createScheduled('未举行重排议题');
    const upcomingCancel = await createScheduled('未来取消议题');
    const editable = await createScheduled('改期边界议题');
    const claimed = await phaseApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '非法排期议题', summary: '过去和当前时间不能排期。', proposer: '时间测试', presenter: '时间测试', tags: [] },
    });

    for (const scheduledAt of [new Date(clock.getTime() - 1).toISOString(), clock.toISOString()]) {
      const rejected = await phaseApp.inject({
        method: 'POST', url: `/api/topics/${claimed.json().id}/schedule`, headers: ifMatch(claimed.json().revision),
        payload: { scheduledAt, duration: 30, room: '非法时间会议室', meetingUrl: '' },
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.json().code, 'ACTIVITY_TIME_INVALID');
    }
    const unchangedClaimed = await readTopic(phaseApp, claimed.json().id);
    assert.equal(unchangedClaimed.status, 'CLAIMED');
    assert.equal(unchangedClaimed.revision, claimed.json().revision);

    clock = new Date(start - 1);
    const upcomingJoin = await phaseApp.inject({ method: 'POST', url: `/api/topics/${main.id}/participants`, payload: { name: '边界前参与者' } });
    assert.equal(upcomingJoin.statusCode, 201);
    const upcomingLeave = await phaseApp.inject({ method: 'DELETE', url: `/api/topics/${main.id}/participants/${upcomingJoin.json().id}` });
    assert.equal(upcomingLeave.statusCode, 204);
    const keeper = await phaseApp.inject({ method: 'POST', url: `/api/topics/${main.id}/participants`, payload: { name: '保留到结束的参与者' } });
    assert.equal(keeper.statusCode, 201);
    assert.equal((await phaseApp.inject({ method: 'GET', url: `/api/topics/${main.id}/meeting-access` })).statusCode, 200);

    const beforeEarlyArchive = await readTopic(phaseApp, main.id);
    const earlyArchive = await phaseApp.inject({
      method: 'POST', url: `/api/topics/${main.id}/archive`, headers: ifMatch(beforeEarlyArchive.revision),
      payload: { takeaway: '不能提前写入', materialUrl: '' },
    });
    assert.equal(earlyArchive.statusCode, 409);
    assert.equal(earlyArchive.json().code, 'ACTIVITY_TIME_CONFLICT');
    assert.equal(earlyArchive.json().phase, 'UPCOMING');
    assert.deepEqual(await readTopic(phaseApp, main.id), beforeEarlyArchive);

    const missingRevision = await phaseApp.inject({
      method: 'POST', url: `/api/topics/${main.id}/archive`,
      payload: { takeaway: '不能绕过 If-Match', materialUrl: '' },
    });
    assert.equal(missingRevision.statusCode, 428);
    const missingTopic = await phaseApp.inject({
      method: 'POST', url: '/api/topics/999999/archive', headers: ifMatch(1),
      payload: { takeaway: '不存在的议题', materialUrl: '' },
    });
    assert.equal(missingTopic.statusCode, 404);

    const editableBefore = await readTopic(phaseApp, editable.id);
    const invalidPatch = await phaseApp.inject({
      method: 'PATCH', url: `/api/topics/${editable.id}`, headers: ifMatch(editableBefore.revision),
      payload: { scheduledAt: clock.toISOString() },
    });
    assert.equal(invalidPatch.statusCode, 400);
    assert.equal(invalidPatch.json().code, 'ACTIVITY_TIME_INVALID');
    assert.deepEqual(await readTopic(phaseApp, editable.id), editableBefore);
    const validPatch = await phaseApp.inject({
      method: 'PATCH', url: `/api/topics/${editable.id}`, headers: ifMatch(editableBefore.revision), payload: { duration: 50 },
    });
    assert.equal(validPatch.statusCode, 200);
    assert.equal(validPatch.json().duration, 50);

    const resetJoin = await phaseApp.inject({ method: 'POST', url: `/api/topics/${reset.id}/participants`, payload: { name: '旧报名' } });
    assert.equal(resetJoin.statusCode, 201);
    const cancelJoin = await phaseApp.inject({ method: 'POST', url: `/api/topics/${upcomingCancel.id}/participants`, payload: { name: '将被取消' } });
    assert.equal(cancelJoin.statusCode, 201);
    const cancelled = await phaseApp.inject({
      method: 'POST', url: `/api/topics/${upcomingCancel.id}/unschedule`,
      headers: ifMatch((await readTopic(phaseApp, upcomingCancel.id)).revision), payload: {},
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, 'CLAIMED');
    assert.deepEqual((await phaseApp.inject({ method: 'GET', url: `/api/topics/${upcomingCancel.id}/participants` })).json(), []);

    const revisionBeforeLive = (await readTopic(phaseApp, main.id)).revision;
    clock = new Date(start);
    const liveJoin = await phaseApp.inject({ method: 'POST', url: `/api/topics/${main.id}/participants`, payload: { name: '迟到参与者' } });
    assert.equal(liveJoin.statusCode, 201);
    assert.equal((await phaseApp.inject({ method: 'GET', url: `/api/topics/${main.id}/meeting-access` })).statusCode, 200);

    const staleArchive = await phaseApp.inject({
      method: 'POST', url: `/api/topics/${main.id}/archive`, headers: ifMatch(revisionBeforeLive),
      payload: { takeaway: '陈旧版本不能被阶段错误掩盖', materialUrl: '' },
    });
    assert.equal(staleArchive.statusCode, 412);
    assert.equal(staleArchive.json().code, 'TOPIC_REVISION_CONFLICT');
    const liveSnapshot = await readTopic(phaseApp, main.id);
    for (const [method, url, payload] of [
      ['POST', `/api/topics/${main.id}/archive`, { takeaway: '进行中不能归档', materialUrl: '' }],
      ['POST', `/api/topics/${main.id}/unschedule`, {}],
      ['PATCH', `/api/topics/${main.id}`, { duration: 60 }],
    ] as const) {
      const rejected = await phaseApp.inject({ method, url, headers: ifMatch(liveSnapshot.revision), payload });
      assert.equal(rejected.statusCode, 409, `${method} ${url}`);
      assert.equal(rejected.json().code, 'ACTIVITY_TIME_CONFLICT');
      assert.equal(rejected.json().phase, 'LIVE');
    }
    assert.deepEqual(await readTopic(phaseApp, main.id), liveSnapshot);

    clock = new Date(end - 1);
    assert.equal((await phaseApp.inject({ method: 'GET', url: `/api/topics/${main.id}/meeting-access` })).statusCode, 200);
    clock = new Date(end);
    const endedSnapshot = await readTopic(phaseApp, main.id);
    const endedJoin = await phaseApp.inject({ method: 'POST', url: `/api/topics/${main.id}/participants`, payload: { name: '结束后报名' } });
    assert.equal(endedJoin.statusCode, 409);
    assert.equal(endedJoin.json().code, 'ACTIVITY_TIME_CONFLICT');
    const endedLeave = await phaseApp.inject({ method: 'DELETE', url: `/api/topics/${main.id}/participants/${keeper.json().id}` });
    assert.equal(endedLeave.statusCode, 409);
    assert.equal(endedLeave.json().code, 'ACTIVITY_TIME_CONFLICT');
    const endedMeeting = await phaseApp.inject({ method: 'GET', url: `/api/topics/${main.id}/meeting-access` });
    assert.equal(endedMeeting.statusCode, 409);
    assert.equal(endedMeeting.json().code, 'ACTIVITY_TIME_CONFLICT');
    assert.equal(endedMeeting.body.includes(meetingSecret), false);
    assert.deepEqual(await readTopic(phaseApp, main.id), endedSnapshot);
    assert.deepEqual(
      (await phaseApp.inject({ method: 'GET', url: `/api/topics/${main.id}/participants` })).json().map(({ name }: { name: string }) => name),
      ['保留到结束的参与者', '迟到参与者'],
    );

    const archived = await phaseApp.inject({
      method: 'POST', url: `/api/topics/${main.id}/archive`, headers: ifMatch(endedSnapshot.revision),
      payload: { takeaway: '结束边界允许归档', materialUrl: '' },
    });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().status, 'ARCHIVED');
    const archivedMeeting = await phaseApp.inject({ method: 'GET', url: `/api/topics/${main.id}/meeting-access` });
    assert.equal(archivedMeeting.statusCode, 409);
    assert.equal(archivedMeeting.body.includes(meetingSecret), false);

    const resetBefore = await readTopic(phaseApp, reset.id);
    const resetResponse = await phaseApp.inject({
      method: 'POST', url: `/api/topics/${reset.id}/unschedule`, headers: ifMatch(resetBefore.revision), payload: {},
    });
    assert.equal(resetResponse.statusCode, 200);
    assert.equal(resetResponse.json().status, 'CLAIMED');
    assert.equal(resetResponse.json().scheduledAt, null);
    assert.equal(resetResponse.json().duration, null);
    assert.equal(resetResponse.json().room, null);
    assert.equal(resetResponse.json().hasMeetingUrl, false);
    assert.deepEqual((await phaseApp.inject({ method: 'GET', url: `/api/topics/${reset.id}/participants` })).json(), []);

    await phaseApp.close();
  });

  it('拒绝把会议链接或凭证写入地点且保留普通地点', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '地点边界议题', summary: '会议秘密只能进入受保护字段。', proposer: '组织者', presenter: '组织者', tags: [] },
    });
    const id = created.json().id as number;
    let revision = created.json().revision as number;
    const sensitiveRooms = [
      'https://meet.example.test/join?passcode=omega',
      'https://meet.example.test/join/(room-42)?token=TOPSECRET',
      '线上入口：https://meet.example.test/join?pwd=omega',
      '请访问 www.example.test/join?pwd=omega',
      '腾讯会议 123 456 789，密码：秘密口令',
      'Teams 会议号=998877 passcode = a-b_C',
      '线上参与 pwd=hidden-token',
      '入会密码（括号密语）',
      '会议号[123 456 789]',
      'PWD【omega】',
      '腾讯会议〔987 654 321〕',
    ];
    for (const room of sensitiveRooms) {
      const response = await app.inject({
        method: 'POST', url: `/api/topics/${id}/schedule`,
        headers: ifMatch(revision),
        payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 30, room, meetingUrl: '' },
      });
      assert.equal(response.statusCode, 400, room);
      assert.equal(response.json().code, 'SENSITIVE_ROOM_CONTENT', room);
    }

    const scheduled = await app.inject({
      method: 'POST', url: `/api/topics/${id}/schedule`,
      headers: ifMatch(revision),
      payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 30, room: '腾讯会议室 A', meetingUrl: '' },
    });
    assert.equal(scheduled.statusCode, 200);
    revision = scheduled.json().revision;
    for (const room of [
      '密码学读书会',
      '3号会议室',
      '三楼围炉会议室',
      '密码学（基础）',
      '3号会议室（东区）',
      '腾讯会议室【A区】',
      'Zoom（产品设计）',
      'Teams〔协作复盘〕',
    ]) {
      const response = await app.inject({ method: 'PATCH', url: `/api/topics/${id}`, headers: ifMatch(revision), payload: { room } });
      assert.equal(response.statusCode, 200, room);
      revision = response.json().revision;
    }
    for (const room of sensitiveRooms) {
      const response = await app.inject({ method: 'PATCH', url: `/api/topics/${id}`, headers: ifMatch(revision), payload: { room } });
      assert.equal(response.statusCode, 400, room);
      assert.equal(response.json().code, 'SENSITIVE_ROOM_CONTENT', room);
    }
    await deleteTopicThroughLifecycle(app, id);
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
      headers: ifMatch(created.json().revision),
      payload: { title: '编辑后的议题', summary: '修改后的简介。', proposer: '新发起人', tags: ['新标签', 'CRUD'] },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().title, '编辑后的议题');
    assert.deepEqual(updated.json().tags, ['新标签', 'CRUD']);

    const invalidUrl = await app.inject({ method: 'PATCH', url: `/api/topics/${id}`, headers: ifMatch(updated.json().revision), payload: { materialUrl: 'javascript:alert(1)' } });
    assert.equal(invalidUrl.statusCode, 400);
    const bypassState = await app.inject({
      method: 'PATCH', url: `/api/topics/${id}`,
      headers: ifMatch(updated.json().revision),
      payload: { scheduledAt: new Date().toISOString(), duration: 30, room: '越级排期' },
    });
    assert.equal(bypassState.statusCode, 409);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(updated.json().revision) });
    assert.equal(deleted.statusCode, 204);
    const duplicate = await app.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(updated.json().revision) });
    assert.equal(duplicate.statusCode, 404);
    const topics = await app.inject({ method: 'GET', url: '/api/topics' });
    assert.equal(topics.json().some((topic: { id: number }) => topic.id === id), false);
  });

  it('只允许早期议题永久删除，并让成熟状态沿真实生命周期回退', async () => {
    appNow = new Date('2026-09-02T10:00:00.000Z');
    const open = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '误建的开放议题', summary: '只用于验证早期永久删除。', proposer: '协调者', tags: [] },
    });
    const claimed = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '误建的准备议题', summary: '认领署名会随议题删除。', proposer: '协调者', presenter: '分享者', tags: [] },
    });
    const beforeEarlyDeletes = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const beforeEarlyTopics = beforeEarlyDeletes.json() as { id: number; revision: number; updatedAt: string }[];
    const earlyVersion = Number(beforeEarlyDeletes.headers['x-order-version']);
    const deletedOpen = await app.inject({ method: 'DELETE', url: `/api/topics/${open.json().id}`, headers: ifMatch(open.json().revision) });
    assert.equal(deletedOpen.statusCode, 204);
    assert.equal(Number(deletedOpen.headers['x-order-version']), earlyVersion + 1);
    const deletedClaimed = await app.inject({ method: 'DELETE', url: `/api/topics/${claimed.json().id}`, headers: ifMatch(claimed.json().revision) });
    assert.equal(deletedClaimed.statusCode, 204);
    assert.equal(Number(deletedClaimed.headers['x-order-version']), earlyVersion + 2);
    const afterEarlyDeletes = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.deepEqual((afterEarlyDeletes.json() as { position: number }[]).map(({ position }) => position),
      Array.from({ length: afterEarlyDeletes.json().length }, (_, index) => index + 1));
    const removedIds = new Set([open.json().id, claimed.json().id]);
    assert.deepEqual(
      (afterEarlyDeletes.json() as { id: number; revision: number; updatedAt: string }[]).map(({ id, revision, updatedAt }) => ({ id, revision, updatedAt })),
      beforeEarlyTopics.filter(({ id }) => !removedIds.has(id)).map(({ id, revision, updatedAt }) => ({ id, revision, updatedAt })),
    );

    const created = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '成熟议题删除保护', summary: '排期、报名和沉淀不能被一步抹掉。', proposer: '协调者', presenter: '分享者', tags: ['保护'] },
    });
    const id = created.json().id as number;
    const scheduledAt = new Date(appNow.getTime() + 60 * 60_000).toISOString();
    const scheduled = await app.inject({
      method: 'POST', url: `/api/topics/${id}/schedule`, headers: ifMatch(created.json().revision),
      payload: { scheduledAt, duration: 40, room: '成熟状态会议室', meetingUrl: 'https://meet.example.test/protected' },
    });
    const joined = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: '报名伙伴' } });
    assert.equal(joined.statusCode, 201);
    const scheduledLatest = await readTopic(app, id);
    assert.equal(scheduledLatest.revision, scheduled.json().revision + 1);
    const rejectDeleteWithoutMutation = async (requestRevision: number, expectedStatus: 409 | 412) => {
      const beforeTopic = await app.inject({ method: 'GET', url: `/api/topics/${id}` });
      const beforeList = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
      const beforeParticipants = await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` });
      const response = await app.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(requestRevision) });
      assert.equal(response.statusCode, expectedStatus);
      const afterTopic = await app.inject({ method: 'GET', url: `/api/topics/${id}` });
      const afterList = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
      const afterParticipants = await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` });
      assert.equal(afterTopic.body, beforeTopic.body);
      assert.equal(afterList.body, beforeList.body);
      assert.equal(afterList.headers['x-order-version'], beforeList.headers['x-order-version']);
      assert.equal(afterParticipants.body, beforeParticipants.body);
      return response;
    };

    const staleDelete = await rejectDeleteWithoutMutation(scheduled.json().revision, 412);
    assert.equal(staleDelete.statusCode, 412);
    assert.equal(staleDelete.json().currentRevision, scheduledLatest.revision);
    const upcomingDelete = await rejectDeleteWithoutMutation(scheduledLatest.revision, 409);
    assert.deepEqual(upcomingDelete.json(), {
      code: 'TOPIC_DELETE_STATE_CONFLICT',
      message: '已排期议题不能直接删除，请先按活动实际情况取消排期或标记未举行',
      currentRevision: scheduledLatest.revision,
      currentStatus: 'SCHEDULED',
    });

    appNow = new Date(new Date(scheduledAt).getTime() + 60_000);
    await rejectDeleteWithoutMutation(scheduledLatest.revision, 409);
    const liveUnschedule = await app.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, headers: ifMatch(scheduledLatest.revision), payload: {} });
    assert.equal(liveUnschedule.statusCode, 409);
    assert.equal(liveUnschedule.json().phase, 'LIVE');

    appNow = new Date(new Date(scheduledAt).getTime() + 40 * 60_000);
    await rejectDeleteWithoutMutation(scheduledLatest.revision, 409);
    const archived = await app.inject({
      method: 'POST', url: `/api/topics/${id}/archive`, headers: ifMatch(scheduledLatest.revision),
      payload: { takeaway: '报名伙伴与沉淀都必须保留。', materialUrl: 'https://example.test/material' },
    });
    assert.equal(archived.statusCode, 200);
    const archivedDelete = await rejectDeleteWithoutMutation(archived.json().revision, 409);
    assert.equal(archivedDelete.json().code, 'TOPIC_DELETE_STATE_CONFLICT');
    assert.equal(archivedDelete.json().currentStatus, 'ARCHIVED');
    const retainedArchive = await readTopic(app, id);
    assert.equal(retainedArchive.takeaway, '报名伙伴与沉淀都必须保留。');
    assert.equal(retainedArchive.materialUrl, 'https://example.test/material');
    assert.equal(retainedArchive.participantCount, 1);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` })).json().map(({ name }: { name: string }) => name), ['报名伙伴']);
    const unarchived = await app.inject({ method: 'POST', url: `/api/topics/${id}/unarchive`, headers: ifMatch(archived.json().revision), payload: {} });
    assert.equal(unarchived.statusCode, 200);
    await rejectDeleteWithoutMutation(unarchived.json().revision, 409);
    const reset = await app.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, headers: ifMatch(unarchived.json().revision), payload: {} });
    assert.equal(reset.statusCode, 200);
    assert.equal(reset.json().status, 'CLAIMED');
    assert.equal(reset.json().participantCount, 0);
    const deletedAfterReset = await app.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(reset.json().revision) });
    assert.equal(deletedAfterReset.statusCode, 204);
  });

  it('拒绝带成熟依赖的异常早期议题且不级联清理', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-abnormal-delete-'));
    const databasePath = path.join(directory, 'shared.db');
    const abnormalApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await abnormalApp.ready();
    const directDb = new Database(databasePath);
    const dependencies = [
      ['scheduled_at', '2026-09-03T10:00:00.000Z'],
      ['duration', 40],
      ['room', '异常残留会议室'],
      ['meeting_url', 'https://meet.example.test/abnormal-hidden'],
      ['takeaway', '异常残留收获'],
      ['material_url', 'https://example.test/abnormal-material'],
      ['archived_at', '2026-09-02T10:00:00.000Z'],
    ] as const;
    const abnormalTopics: { id: number; revision: number; column: string }[] = [];
    for (const [column, value] of dependencies) {
      const created = await abnormalApp.inject({
        method: 'POST', url: '/api/topics',
        payload: { title: `异常准备中-${column}`, summary: '状态早期但意外残留成熟字段。', proposer: '协调者', presenter: '分享者', tags: [] },
      });
      const id = created.json().id as number;
      directDb.prepare(`UPDATE topics SET ${column} = ? WHERE id = ?`).run(value, id);
      abnormalTopics.push({ id, revision: created.json().revision, column });
    }
    const participantTopic = await abnormalApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '异常准备中-participant', summary: '状态早期但意外残留报名。', proposer: '协调者', presenter: '分享者', tags: [] },
    });
    const participantId = participantTopic.json().id as number;
    directDb.prepare('INSERT INTO topic_participants (topic_id, name, normalized_name, created_at) VALUES (?, ?, ?, ?)')
      .run(participantId, '残留伙伴', '残留伙伴', new Date().toISOString());
    directDb.close();
    const before = await abnormalApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const beforeVersion = before.headers['x-order-version'];
    assert.equal((before.json() as { id: number; participantCount: number }[]).find(({ id }) => id === participantId)?.participantCount, 1);
    const meetingTopic = (before.json() as { id: number; hasMeetingUrl: boolean; meetingUrl: string | null }[])
      .find(({ id }) => id === abnormalTopics.find(({ column }) => column === 'meeting_url')!.id)!;
    assert.equal(meetingTopic.hasMeetingUrl, true);
    assert.equal(meetingTopic.meetingUrl, null);

    for (const topic of abnormalTopics) {
      const rejected = await abnormalApp.inject({ method: 'DELETE', url: `/api/topics/${topic.id}`, headers: ifMatch(topic.revision) });
      assert.equal(rejected.statusCode, 409, topic.column);
      assert.equal(rejected.json().code, 'TOPIC_DELETE_STATE_CONFLICT', topic.column);
      assert.equal(rejected.json().currentStatus, 'CLAIMED', topic.column);
    }
    const participantRejected = await abnormalApp.inject({
      method: 'DELETE', url: `/api/topics/${participantId}`, headers: ifMatch(participantTopic.json().revision),
    });
    assert.equal(participantRejected.statusCode, 409);
    const after = await abnormalApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.equal(after.headers['x-order-version'], beforeVersion);
    assert.equal(after.body, before.body);
    assert.deepEqual((await abnormalApp.inject({ method: 'GET', url: `/api/topics/${participantId}/participants` })).json().map(({ name }: { name: string }) => name), ['残留伙伴']);

    await abnormalApp.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('删除响应返回自身事务产生的精确排序版本', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-delete-order-version-'));
    const databasePath = path.join(directory, 'shared.db');
    let signalCommitted!: () => void;
    let releaseResponse!: () => void;
    const committed = new Promise<void>((resolve) => { signalCommitted = resolve; });
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const deletingApp = buildApp({
      databasePath, seed: false, serveStatic: false,
      afterTopicDeleteCommit: async () => { signalCommitted(); await responseReleased; },
    });
    await deletingApp.ready();
    const writingApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await writingApp.ready();
    const target = await writingApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '精确版本删除目标', summary: '响应暂停后发生另一笔成员变化。', proposer: '并发测试', tags: [] },
    });
    await writingApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '精确版本保留议题', summary: '用于保持列表非空。', proposer: '并发测试', tags: [] },
    });
    const before = await writingApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const beforeVersion = Number(before.headers['x-order-version']);

    const pendingDelete = deletingApp.inject({ method: 'DELETE', url: `/api/topics/${target.json().id}`, headers: ifMatch(target.json().revision) });
    await committed;
    const laterCreate = await writingApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '删除提交后的新成员', summary: '不得污染删除响应头。', proposer: '并发测试', tags: [] },
    });
    assert.equal(laterCreate.statusCode, 201);
    releaseResponse();
    const deleted = await pendingDelete;
    assert.equal(deleted.statusCode, 204);
    assert.equal(Number(deleted.headers['x-order-version']), beforeVersion + 1);
    const latest = await writingApp.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.equal(Number(latest.headers['x-order-version']), beforeVersion + 2);

    await Promise.all([deletingApp.close(), writingApp.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  it('双连接读取后排期与报名会使陈旧删除 412 且最新版删除 409', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-delete-lifecycle-race-'));
    const databasePath = path.join(directory, 'shared.db');
    const deletingApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await deletingApp.ready();
    const lifecycleApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await lifecycleApp.ready();
    const created = await lifecycleApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '双连接成熟状态竞态', summary: '读取确认后另一连接推进生命周期。', proposer: '协调者', presenter: '分享者', tags: [] },
    });
    const id = created.json().id as number;
    const staleSnapshot = await readTopic(deletingApp, id);
    const scheduled = await lifecycleApp.inject({
      method: 'POST', url: `/api/topics/${id}/schedule`, headers: ifMatch(staleSnapshot.revision),
      payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 40, room: '双连接会议室', meetingUrl: '' },
    });
    assert.equal(scheduled.statusCode, 200);
    const joined = await lifecycleApp.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: '并发报名伙伴' } });
    assert.equal(joined.statusCode, 201);

    const staleDelete = await deletingApp.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(staleSnapshot.revision) });
    assert.equal(staleDelete.statusCode, 412);
    const latest = await readTopic(deletingApp, id);
    assert.equal(staleDelete.json().currentRevision, latest.revision);
    assert.equal(latest.status, 'SCHEDULED');
    assert.equal(latest.participantCount, 1);
    const freshDelete = await deletingApp.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(latest.revision) });
    assert.equal(freshDelete.statusCode, 409);
    assert.equal(freshDelete.json().code, 'TOPIC_DELETE_STATE_CONFLICT');
    assert.deepEqual((await lifecycleApp.inject({ method: 'GET', url: `/api/topics/${id}/participants` })).json().map(({ name }: { name: string }) => name), ['并发报名伙伴']);

    const reset = await lifecycleApp.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, headers: ifMatch(latest.revision), payload: {} });
    assert.equal(reset.statusCode, 200);
    assert.equal((await deletingApp.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(reset.json().revision) })).statusCode, 204);
    await Promise.all([deletingApp.close(), lifecycleApp.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  it('要求所有议题命令携带强 If-Match 并拒绝非法格式', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '版本头契约', summary: '验证全部命令的前置条件。', proposer: '测试者', tags: [] },
    });
    const id = created.json().id as number;
    const commands = [
      { method: 'PATCH', url: `/api/topics/${id}`, payload: { title: '缺少版本' } },
      { method: 'DELETE', url: `/api/topics/${id}` },
      { method: 'POST', url: `/api/topics/${id}/claim`, payload: { presenter: '分享者' } },
      { method: 'POST', url: `/api/topics/${id}/release`, payload: {} },
      { method: 'POST', url: `/api/topics/${id}/schedule`, payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 30, room: '会议室' } },
      { method: 'POST', url: `/api/topics/${id}/unschedule`, payload: {} },
      { method: 'POST', url: `/api/topics/${id}/archive`, payload: { takeaway: '', materialUrl: '' } },
      { method: 'POST', url: `/api/topics/${id}/unarchive`, payload: {} },
    ] as const;
    for (const command of commands) {
      const response = await app.inject(command);
      assert.equal(response.statusCode, 428, `${command.method} ${command.url}`);
      assert.equal(response.json().code, 'TOPIC_REVISION_REQUIRED');
    }

    for (const value of ['', '1', 'W/"1"', '*', '"0"', '"01"', '"-1"', '"1", "2"', '"abc"']) {
      const response = await app.inject({
        method: 'PATCH', url: `/api/topics/${id}`, headers: { 'if-match': value }, payload: { title: '非法版本' },
      });
      assert.equal(response.statusCode, 400, value);
      assert.equal(response.json().code, 'INVALID_TOPIC_REVISION', value);
    }
    assert.equal((await readTopic(app, id)).revision, 1);
  });

  it('拒绝陈旧编辑和删除且保留较新的议题内容', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '陈旧写保护', summary: '两个协作者从同一个快照开始。', proposer: '测试者', tags: [] },
    });
    const id = created.json().id as number;
    const snapshotRevision = created.json().revision as number;
    const firstEdit = await app.inject({
      method: 'PATCH', url: `/api/topics/${id}`, headers: ifMatch(snapshotRevision), payload: { title: '先提交的标题' },
    });
    assert.equal(firstEdit.statusCode, 200);
    assert.equal(firstEdit.json().revision, snapshotRevision + 1);

    const staleEdit = await app.inject({
      method: 'PATCH', url: `/api/topics/${id}`, headers: ifMatch(snapshotRevision), payload: { summary: '不应覆盖的新简介' },
    });
    assert.equal(staleEdit.statusCode, 412);
    assert.equal(staleEdit.json().code, 'TOPIC_REVISION_CONFLICT');
    assert.equal(staleEdit.json().currentRevision, snapshotRevision + 1);
    const staleDelete = await app.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(snapshotRevision) });
    assert.equal(staleDelete.statusCode, 412);
    assert.equal(staleDelete.json().code, 'TOPIC_REVISION_CONFLICT');

    const authoritative = await readTopic(app, id);
    assert.equal(authoritative.title, '先提交的标题');
    assert.equal(authoritative.summary, '两个协作者从同一个快照开始。');
    assert.equal(authoritative.revision, snapshotRevision + 1);
  });

  it('报名推进聚合版本并让陈旧取消排期失败且不丢名单', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '报名版本保护', summary: '报名发生后旧确认不能清空名单。', proposer: '组织者', presenter: '组织者', tags: [] },
    });
    assert.equal(created.json().revision, 1);
    const id = created.json().id as number;
    const scheduled = await app.inject({
      method: 'POST', url: `/api/topics/${id}/schedule`, headers: ifMatch(1),
      payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 45, room: '报名会议室' },
    });
    assert.equal(scheduled.statusCode, 200);
    assert.equal(scheduled.json().revision, 2);

    const firstJoin = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: 'Alice' } });
    assert.equal(firstJoin.statusCode, 201);
    assert.equal((await readTopic(app, id)).revision, 3);
    const duplicateJoin = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: ' alice ' } });
    assert.equal(duplicateJoin.statusCode, 409);
    assert.equal((await readTopic(app, id)).revision, 3);
    const secondJoin = await app.inject({ method: 'POST', url: `/api/topics/${id}/participants`, payload: { name: '小林' } });
    assert.equal(secondJoin.statusCode, 201);
    assert.equal((await readTopic(app, id)).revision, 4);
    const left = await app.inject({ method: 'DELETE', url: `/api/topics/${id}/participants/${firstJoin.json().id}` });
    assert.equal(left.statusCode, 204);
    assert.equal((await readTopic(app, id)).revision, 5);
    const missingLeave = await app.inject({ method: 'DELETE', url: `/api/topics/${id}/participants/${firstJoin.json().id}` });
    assert.equal(missingLeave.statusCode, 404);
    assert.equal((await readTopic(app, id)).revision, 5);

    const beforeStaleDelete = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const staleDelete = await app.inject({
      method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(scheduled.json().revision),
    });
    assert.equal(staleDelete.statusCode, 412);
    assert.equal(staleDelete.json().currentRevision, 5);
    const afterStaleDelete = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    assert.equal(afterStaleDelete.headers['x-order-version'], beforeStaleDelete.headers['x-order-version']);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` })).json().map(({ name }: { name: string }) => name), ['小林']);

    const staleUnschedule = await app.inject({
      method: 'POST', url: `/api/topics/${id}/unschedule`, headers: ifMatch(scheduled.json().revision), payload: {},
    });
    assert.equal(staleUnschedule.statusCode, 412);
    assert.equal(staleUnschedule.json().currentRevision, 5);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` })).json().map(({ name }: { name: string }) => name), ['小林']);

    const unscheduled = await app.inject({
      method: 'POST', url: `/api/topics/${id}/unschedule`, headers: ifMatch(5), payload: {},
    });
    assert.equal(unscheduled.statusCode, 200);
    assert.equal(unscheduled.json().revision, 6);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/topics/${id}/participants` })).json(), []);
  });

  it('持久化完整的手动排序并拒绝不完整列表', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const beforeTopics = before.json() as { id: number; revision: number; updatedAt: string }[];
    const ids = beforeTopics.map(({ id }) => id);
    const baseVersion = Number(before.headers['x-order-version']);
    const reversed = [...ids].reverse();
    const reordered = await app.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: reversed, baseVersion } });
    assert.equal(reordered.statusCode, 204);
    assert.equal(Number(reordered.headers['x-order-version']), baseVersion + 1);
    const after = await app.inject({ method: 'GET', url: '/api/topics?sort=manual' });
    const afterTopics = after.json() as { id: number; revision: number; updatedAt: string }[];
    assert.deepEqual(afterTopics.map(({ id }) => id), reversed);
    const beforeById = new Map(beforeTopics.map(({ id, revision, updatedAt }) => [id, { revision, updatedAt }]));
    for (const topic of afterTopics) {
      assert.deepEqual({ revision: topic.revision, updatedAt: topic.updatedAt }, beforeById.get(topic.id));
    }
    const reorderedTarget = afterTopics[0];
    const editAfterReorder = await app.inject({
      method: 'PATCH', url: `/api/topics/${reorderedTarget.id}`, headers: ifMatch(reorderedTarget.revision),
      payload: { summary: '排序后原议题版本仍然有效。' },
    });
    assert.equal(editAfterReorder.statusCode, 200);
    assert.equal(editAfterReorder.json().revision, reorderedTarget.revision + 1);

    const currentVersion = Number(after.headers['x-order-version']);
    const incomplete = await app.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: reversed.slice(1), baseVersion: currentVersion } });
    assert.equal(incomplete.statusCode, 400);
    const duplicate = await app.inject({ method: 'POST', url: '/api/topics/reorder', payload: { orderedIds: [reversed[0], reversed[0]], baseVersion: currentVersion } });
    assert.equal(duplicate.statusCode, 400);
  });
});

describe('数据库兼容性与并发', () => {
  it('同口令重启保留未到期会话而口令轮换立即使旧会话失效', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-key-rotation-'));
    const databasePath = path.join(directory, 'rotation.db');
    const now = () => new Date('2026-09-02T10:00:00.000Z');
    const firstApp = buildApp({ databasePath, seed: false, serveStatic: false, writeKey: 'old-key', now });
    await firstApp.ready();
    const oldSession = await issueSession(firstApp, 'old-key');
    const created = await firstApp.inject({
      method: 'POST', url: '/api/topics', headers: { 'x-fireside-session': oldSession.sessionToken },
      payload: { title: '口令轮换议题', summary: '轮换口令不能影响业务数据。', proposer: '安全测试', tags: [] },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as number;
    await firstApp.close();

    const restartedApp = buildApp({ databasePath, seed: false, serveStatic: false, writeKey: 'old-key', now });
    await restartedApp.ready();
    const stillValid = await restartedApp.inject({
      method: 'GET', url: '/api/access/session', headers: { 'x-fireside-session': oldSession.sessionToken },
    });
    assert.equal(stillValid.statusCode, 200);
    await restartedApp.close();

    const rotatedApp = buildApp({ databasePath, seed: false, serveStatic: false, writeKey: 'new-key', now });
    await rotatedApp.ready();
    assert.equal((await rotatedApp.inject({ method: 'GET', url: '/api/topics' })).json()[0].title, '口令轮换议题');
    const oldTokenRejected = await rotatedApp.inject({
      method: 'PATCH', url: `/api/topics/${id}`,
      headers: { 'x-fireside-session': oldSession.sessionToken, ...ifMatch(created.json().revision) }, payload: { title: '不应成功' },
    });
    assert.equal(oldTokenRejected.statusCode, 401);
    assert.equal(oldTokenRejected.json().code, 'ACCESS_SESSION_REQUIRED');
    const newSession = await issueSession(rotatedApp, 'new-key');
    const updated = await rotatedApp.inject({
      method: 'PATCH', url: `/api/topics/${id}`,
      headers: { 'x-fireside-session': newSession.sessionToken, ...ifMatch(created.json().revision) },
      payload: { title: '新口令生效' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().title, '新口令生效');
    await rotatedApp.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('匿名脱敏历史混合会议地点且授权后仍可加入', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-legacy-meeting-room-'));
    const databasePath = path.join(directory, 'shared.db');
    const writeKey = 'legacy-meeting-test-key';
    const legacyApp = buildApp({ databasePath, seed: false, serveStatic: false, writeKey });
    await legacyApp.ready();
    const legacyDb = new Database(databasePath);
    const now = new Date().toISOString();
    const insert = legacyDb.prepare(`
      INSERT INTO topics
        (position, title, summary, proposer, presenter, tags, status, scheduled_at, duration, room, meeting_url, created_at, updated_at)
      VALUES (?, ?, '历史兼容隐私测试', '旧系统', '旧分享人', '[]', 'SCHEDULED', ?, 30, ?, NULL, ?, ?)
    `);
    const mixedSecret = 'legacy-private-token';
    const mixedUrl = `https://meet.example.test/legacy?passcode=${mixedSecret}`;
    const mixedId = Number(insert.run(1, '历史混合 URL', new Date(Date.now() + 86_400_000).toISOString(), `线上入口：${mixedUrl}，请勿转发`, now, now).lastInsertRowid);
    const credentialId = Number(insert.run(2, '历史纯凭证', new Date(Date.now() + 172_800_000).toISOString(), '腾讯会议 123 456 789，密码：秘密口令', now, now).lastInsertRowid);
    insert.run(3, '历史普通地点', new Date(Date.now() + 259_200_000).toISOString(), '密码学读书会 · 3号会议室', now, now);
    legacyDb.close();

    const publicTopics = await legacyApp.inject({ method: 'GET', url: '/api/topics' });
    assert.equal(publicTopics.body.includes(mixedSecret), false);
    assert.equal(publicTopics.body.includes('123 456 789'), false);
    assert.equal(publicTopics.body.includes('秘密口令'), false);
    const topics = publicTopics.json() as { id: number; room: string; hasMeetingUrl: boolean }[];
    const mixedTopic = topics.find(({ id }) => id === mixedId)!;
    assert.equal(mixedTopic.room, '线上会议');
    assert.equal(mixedTopic.hasMeetingUrl, true);
    const credentialTopic = topics.find(({ id }) => id === credentialId)!;
    assert.equal(credentialTopic.room, '线上参与信息已隐藏');
    assert.equal(credentialTopic.hasMeetingUrl, false);
    assert.equal(topics.find(({ room }) => room.includes('密码学读书会'))?.hasMeetingUrl, false);
    const stats = await legacyApp.inject({ method: 'GET', url: '/api/stats' });
    assert.equal(stats.body.includes(mixedSecret), false);
    assert.equal(stats.json().nextTopic.room, '线上会议');
    const session = await issueSession(legacyApp, writeKey);
    const headers = { 'x-fireside-session': session.sessionToken };
    assert.equal((await legacyApp.inject({ method: 'GET', url: `/api/topics/${mixedId}/meeting-access`, headers })).json().meetingUrl, mixedUrl);
    const credentialMeeting = await legacyApp.inject({ method: 'GET', url: `/api/topics/${credentialId}/meeting-access`, headers });
    assert.equal(credentialMeeting.statusCode, 409);
    assert.equal(credentialMeeting.json().code, 'ACTIVITY_TIME_CONFLICT');

    await legacyApp.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('演示数据只初始化一次，用户清空后重启不会复活', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-seed-once-'));
    const databasePath = path.join(directory, 'seed.db');
    const firstStart = buildApp({ databasePath, seed: true, serveStatic: false });
    await firstStart.ready();
    const seeded = await firstStart.inject({ method: 'GET', url: '/api/topics' });
    assert.equal(seeded.json().length, 4);
    for (const topic of seeded.json() as { id: number }[]) await deleteTopicThroughLifecycle(firstStart, topic.id);
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
    const migratedTopics = response.json() as { title: string; position: number; revision: number }[];
    assert.deepEqual(migratedTopics.map(({ title, position }) => ({ title, position })), [
      { title: '旧议题一', position: 1 },
      { title: '旧议题二', position: 2 },
    ]);
    assert.deepEqual(migratedTopics.map(({ revision }) => revision), [1, 1]);
    const migratedDb = new Database(databasePath);
    const revisionColumn = (migratedDb.prepare("PRAGMA table_info('topics')").all() as { name: string; notnull: number; dflt_value: string | null }[])
      .find(({ name }) => name === 'revision');
    assert.deepEqual(revisionColumn && { notnull: revisionColumn.notnull, defaultValue: revisionColumn.dflt_value }, { notnull: 1, defaultValue: '1' });
    migratedDb.close();
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
      createdAt: string; updatedAt: string; archivedAt: string | null; revision: number;
    }>;
    assert.deepEqual(firstTopics.map(({ title, position }) => ({ title, position })), [
      { title: '旧议题乙', position: 1 },
      { title: '旧议题丙', position: 2 },
      { title: '旧议题甲', position: 3 },
    ]);
    assert.deepEqual(firstTopics.map(({ revision }) => revision), [1, 1, 1]);
    await firstStart.close();

    const verifyBusinessData = new Database(databasePath);
    const afterRows = verifyBusinessData.prepare('SELECT * FROM topics ORDER BY id').all() as Array<Record<string, unknown> & { position: number }>;
    const legacyBusinessColumns = ({ position: _position, meeting_url: _meetingUrl, revision: _revision, ...row }: Record<string, unknown> & { position: number }) => row;
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
    const revision = created.json().revision as number;
    const [first, second] = await Promise.all([
      firstApp.inject({ method: 'POST', url: `/api/topics/${id}/claim`, headers: ifMatch(revision), payload: { presenter: '认领人甲' } }),
      secondApp.inject({ method: 'POST', url: `/api/topics/${id}/claim`, headers: ifMatch(revision), payload: { presenter: '认领人乙' } }),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 412]);
    const loser = first.statusCode === 412 ? first : second;
    assert.equal(loser.json().code, 'TOPIC_REVISION_CONFLICT');
    assert.equal(loser.json().currentRevision, revision + 1);
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
    const claimed = await lifecycleApp.inject({
      method: 'POST', url: `/api/topics/${id}/claim`, headers: ifMatch(created.json().revision), payload: { presenter: '分享人' },
    });
    assert.equal(claimed.statusCode, 200);

    const pendingEdit = editingApp.inject({
      method: 'PATCH', url: `/api/topics/${id}`, headers: ifMatch(claimed.json().revision), payload: { title: '并发后的新标题' },
    });
    await readReached;
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await lifecycleApp.inject({
      method: 'POST', url: `/api/topics/${id}/schedule`,
      headers: ifMatch(claimed.json().revision),
      payload: { scheduledAt, duration: 50, room: '并发测试会议室' },
    });
    assert.equal(scheduled.statusCode, 200);
    releaseUpdate();
    const edited = await pendingEdit;
    assert.equal(edited.statusCode, 412);
    assert.equal(edited.json().code, 'TOPIC_REVISION_CONFLICT');
    assert.equal(edited.json().currentRevision, claimed.json().revision + 1);

    const topics = await lifecycleApp.inject({ method: 'GET', url: '/api/topics' });
    const finalTopic = topics.json()[0];
    assert.equal(finalTopic.title, '并发编辑议题');
    assert.equal(finalTopic.status, 'SCHEDULED');
    assert.equal(finalTopic.presenter, '分享人');
    assert.equal(finalTopic.scheduledAt, scheduledAt);
    assert.equal(finalTopic.duration, 50);
    assert.equal(finalTopic.room, '并发测试会议室');

    await Promise.all([editingApp.close(), lifecycleApp.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  it('状态相关编辑与反向生命周期交错时使用状态 CAS', async () => {
    type RaceCase = {
      name: string;
      setup?: (instance: FastifyInstance, id: number) => Promise<void>;
      editPayload: Record<string, unknown>;
      transition: (instance: FastifyInstance, id: number, revision: number) => Promise<{ statusCode: number }>;
      verify: (topic: Record<string, unknown>) => void;
    };
    let raceNow = new Date();
    const scheduledAt = new Date(raceNow.getTime() + 86_400_000).toISOString();
    const schedule = async (instance: FastifyInstance, id: number) => {
      const revision = (await readTopic(instance, id)).revision;
      const response = await instance.inject({
        method: 'POST', url: `/api/topics/${id}/schedule`,
        headers: ifMatch(revision),
        payload: { scheduledAt, duration: 45, room: '原排期会议室', meetingUrl: 'https://meet.example.test/original' },
      });
      assert.equal(response.statusCode, 200);
    };
    const cases: RaceCase[] = [
      {
        name: '退出认领',
        editPayload: { presenter: '陈旧分享人' },
        transition: (instance, id, revision) => instance.inject({ method: 'POST', url: `/api/topics/${id}/release`, headers: ifMatch(revision), payload: {} }),
        verify: (topic) => {
          assert.equal(topic.status, 'OPEN');
          assert.equal(topic.presenter, null);
        },
      },
      {
        name: '取消排期',
        setup: schedule,
        editPayload: { scheduledAt: new Date(Date.now() + 172_800_000).toISOString(), duration: 60, room: '陈旧新地点' },
        transition: (instance, id, revision) => instance.inject({ method: 'POST', url: `/api/topics/${id}/unschedule`, headers: ifMatch(revision), payload: {} }),
        verify: (topic) => {
          assert.equal(topic.status, 'CLAIMED');
          assert.equal(topic.scheduledAt, null);
          assert.equal(topic.duration, null);
          assert.equal(topic.room, null);
        },
      },
      {
        name: '撤销归档',
        setup: async (instance, id) => {
          await schedule(instance, id);
          const revision = (await readTopic(instance, id)).revision;
          raceNow = new Date(new Date(scheduledAt).getTime() + 45 * 60_000);
          const response = await instance.inject({
            method: 'POST', url: `/api/topics/${id}/archive`,
            headers: ifMatch(revision),
            payload: { takeaway: '原始沉淀', materialUrl: 'https://example.test/original' },
          });
          assert.equal(response.statusCode, 200);
        },
        editPayload: { takeaway: '陈旧沉淀', materialUrl: 'https://example.test/stale' },
        transition: (instance, id, revision) => instance.inject({ method: 'POST', url: `/api/topics/${id}/unarchive`, headers: ifMatch(revision), payload: {} }),
        verify: (topic) => {
          assert.equal(topic.status, 'SCHEDULED');
          assert.equal(topic.takeaway, null);
          assert.equal(topic.materialUrl, null);
        },
      },
    ];

    for (const raceCase of cases) {
      raceNow = new Date();
      const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-state-edit-race-'));
      const databasePath = path.join(directory, 'shared.db');
      let signalRead!: () => void;
      let releaseUpdate!: () => void;
      const readReached = new Promise<void>((resolve) => { signalRead = resolve; });
      const updateReleased = new Promise<void>((resolve) => { releaseUpdate = resolve; });
      const editingApp = buildApp({
        databasePath, seed: false, serveStatic: false,
        now: () => raceNow,
        beforeTopicUpdate: async () => { signalRead(); await updateReleased; },
      });
      const lifecycleApp = buildApp({ databasePath, seed: false, serveStatic: false, now: () => raceNow });
      await Promise.all([editingApp.ready(), lifecycleApp.ready()]);
      const created = await lifecycleApp.inject({
        method: 'POST', url: '/api/topics',
        payload: { title: `${raceCase.name}竞态`, summary: '状态转换必须胜过陈旧编辑。', proposer: '发起人', presenter: '原分享人', tags: [] },
      });
      const id = created.json().id as number;
      await raceCase.setup?.(lifecycleApp, id);
      const snapshotRevision = (await readTopic(lifecycleApp, id)).revision;

      const pendingEdit = editingApp.inject({
        method: 'PATCH', url: `/api/topics/${id}`, headers: ifMatch(snapshotRevision), payload: raceCase.editPayload,
      });
      await readReached;
      const transitioned = await raceCase.transition(lifecycleApp, id, snapshotRevision);
      assert.equal(transitioned.statusCode, 200, `${raceCase.name}应成功`);
      releaseUpdate();
      const edited = await pendingEdit;
      assert.equal(edited.statusCode, 412, `${raceCase.name}后陈旧编辑应冲突`);
      assert.equal(edited.json().code, 'TOPIC_REVISION_CONFLICT');
      assert.equal(edited.json().currentRevision, snapshotRevision + 1);
      const topics = await lifecycleApp.inject({ method: 'GET', url: '/api/topics' });
      raceCase.verify(topics.json()[0] as Record<string, unknown>);

      await Promise.all([editingApp.close(), lifecycleApp.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('状态相关编辑暂停期间被删除时返回 404', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-state-edit-delete-'));
    const databasePath = path.join(directory, 'shared.db');
    let signalRead!: () => void;
    let releaseUpdate!: () => void;
    const readReached = new Promise<void>((resolve) => { signalRead = resolve; });
    const updateReleased = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const editingApp = buildApp({
      databasePath, seed: false, serveStatic: false,
      beforeTopicUpdate: async () => { signalRead(); await updateReleased; },
    });
    const deletingApp = buildApp({ databasePath, seed: false, serveStatic: false });
    await Promise.all([editingApp.ready(), deletingApp.ready()]);
    const created = await deletingApp.inject({
      method: 'POST', url: '/api/topics',
      payload: { title: '并发删除', summary: '删除后不能被编辑复活。', proposer: '发起人', presenter: '分享人', tags: [] },
    });
    const id = created.json().id as number;
    const revision = created.json().revision as number;

    const pendingEdit = editingApp.inject({
      method: 'PATCH', url: `/api/topics/${id}`, headers: ifMatch(revision), payload: { presenter: '陈旧分享人' },
    });
    await readReached;
    assert.equal((await deletingApp.inject({ method: 'DELETE', url: `/api/topics/${id}`, headers: ifMatch(revision) })).statusCode, 204);
    releaseUpdate();
    const edited = await pendingEdit;
    assert.equal(edited.statusCode, 404);

    await Promise.all([editingApp.close(), deletingApp.close()]);
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
    const beforeDeleteTopics = beforeDelete.json() as { id: number; revision: number }[];
    const beforeDeleteIds = beforeDeleteTopics.map(({ id }) => id);
    const deleteTarget = beforeDeleteTopics.at(-1)!;
    await secondApp.inject({ method: 'DELETE', url: `/api/topics/${deleteTarget.id}`, headers: ifMatch(deleteTarget.revision) });
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
