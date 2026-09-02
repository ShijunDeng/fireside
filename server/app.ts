import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createAuthRateLimiter,
  decodeWriteKeyHeader,
  issueCollaborationSession,
  normalizeClientIp,
  validateCollaborationSession,
  writeKeyMatches,
} from './access.js';
import { createDatabase, rowToTopic } from './db.js';
import { analyzeMeetingRoom } from './meeting.js';
import { activityPhase, type ActivityPhase } from '../shared/activity.js';
import type { Topic } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const requestBodyLimit = 1024 * 1024;
const parserErrorResponses = {
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    status: 400,
    code: 'INVALID_JSON_BODY',
    message: '提交内容不是有效的 JSON，请检查后重试',
  },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    status: 400,
    code: 'INVALID_JSON_BODY',
    message: '提交内容不是有效的 JSON，请检查后重试',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: '提交格式不受支持，请使用 JSON',
  },
  FST_ERR_CTP_BODY_TOO_LARGE: {
    status: 413,
    code: 'REQUEST_BODY_TOO_LARGE',
    message: '提交内容过大，请精简后重试',
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    status: 400,
    code: 'INVALID_REQUEST_BODY',
    message: '请求内容不完整，请重新提交',
  },
} as const;

const nonEmptyText = (label: string, max = 120) => z.string().trim().min(1, `${label}不能为空`).max(max, `${label}不能超过 ${max} 个字符`);
const createTopicSchema = z.object({
  title: nonEmptyText('议题标题', 80),
  summary: nonEmptyText('议题简介', 500),
  proposer: nonEmptyText('发起人', 30),
  presenter: nonEmptyText('分享人', 30).optional(),
  tags: z.array(z.string().trim().min(1).max(20)).max(5, '标签最多 5 个').default([]),
});
const claimSchema = z.object({ presenter: nonEmptyText('认领人', 30) });
const scheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  duration: z.number().int().min(10).max(240),
  room: nonEmptyText('地点', 60),
  meetingUrl: z.union([
    z.literal(''),
    z.string().max(2048, '会议链接不能超过 2048 个字符').url('会议链接格式不正确').refine((value) => /^https?:\/\//i.test(value), '会议链接仅支持 http 或 https'),
  ]).default(''),
});
const archiveSchema = z.object({
  takeaway: nonEmptyText('本期收获', 1000),
  materialUrl: z.union([
    z.literal(''),
    z.string().url('资料链接格式不正确').refine((value) => /^https?:\/\//i.test(value), '资料链接仅支持 http 或 https'),
  ]).default(''),
});
const editTopicSchema = z.object({
  title: nonEmptyText('议题标题', 80).optional(),
  summary: nonEmptyText('议题简介', 500).optional(),
  proposer: nonEmptyText('发起人', 30).optional(),
  tags: z.array(z.string().trim().min(1).max(20)).max(5, '标签最多 5 个').optional(),
  presenter: nonEmptyText('分享人', 30).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  duration: z.number().int().min(10).max(240).optional(),
  room: nonEmptyText('地点', 60).optional(),
  meetingUrl: z.union([
    z.literal(''),
    z.string().max(2048, '会议链接不能超过 2048 个字符').url('会议链接格式不正确').refine((value) => /^https?:\/\//i.test(value), '会议链接仅支持 http 或 https'),
  ]).optional(),
  takeaway: nonEmptyText('本期收获', 1000).optional(),
  materialUrl: z.union([
    z.literal(''),
    z.string().url('资料链接格式不正确').refine((value) => /^https?:\/\//i.test(value), '资料链接仅支持 http 或 https'),
  ]).optional(),
}).refine((value) => Object.keys(value).length > 0, '至少需要修改一项内容');
const reorderSchema = z.object({
  orderedIds: z.array(z.number().int().positive()).min(1).refine((ids) => new Set(ids).size === ids.length, '排序列表不能包含重复议题'),
  baseVersion: z.number().int().nonnegative(),
});
const participantSchema = z.object({ name: nonEmptyText('参与者姓名', 30) });
const sensitiveRoomMessage = '地点中不能填写会议链接、会议号或密码，请使用线上会议链接字段';
const stateRestrictedEditFields = new Set([
  'presenter', 'scheduledAt', 'duration', 'room', 'meetingUrl', 'takeaway', 'materialUrl',
]);

type AppOptions = {
  databasePath?: string;
  seed?: boolean;
  logger?: boolean;
  loggerStream?: { write(message: string): void };
  writeKey?: string;
  serveStatic?: boolean;
  now?: () => Date;
  authRateLimit?: {
    windowMs?: number;
    perSourceLimit?: number;
    globalLimit?: number;
    maxSources?: number;
    cleanupInterval?: number;
    cleanupBatchSize?: number;
  };
  beforeTopicUpdate?: () => Promise<void>;
  afterTopicRowsRead?: () => Promise<void>;
  afterTopicDeleteCommit?: () => Promise<void>;
  businessWritesAllowed?: () => boolean;
  releaseCommit?: string;
};

function validationMessage(error: z.ZodError) {
  return error.issues[0]?.message ?? '提交内容不正确';
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    bodyLimit: requestBodyLimit,
    trustProxy: false,
    logger: options.logger ? {
      redact: ['req.headers.x-fireside-write-key', 'req.headers.x-fireside-session'],
      ...(options.loggerStream ? { stream: options.loggerStream } : {}),
    } : false,
  });
  const writeKey = options.writeKey ?? process.env.FIRESIDE_WRITE_KEY ?? '';
  const databasePath = options.databasePath ?? process.env.DATABASE_PATH ?? path.join(projectRoot, 'data', 'fireside.db');
  const db = createDatabase(databasePath, options.seed ?? true);
  const captureNow = () => {
    const value = options.now?.() ?? new Date();
    return new Date(value.getTime());
  };
  const authNow = () => captureNow().getTime();
  const authRateLimiter = createAuthRateLimiter({ now: authNow, ...options.authRateLimit });
  const expectedRevisions = new WeakMap<FastifyRequest, number>();
  const validatedSessions = new WeakMap<FastifyRequest, { expiresAt: string }>();
  const readOrderVersion = () => (db.prepare('SELECT version FROM topic_order_state WHERE id = 1').get() as { version: number }).version;
  const bumpOrderVersion = () => (db.prepare('UPDATE topic_order_state SET version = version + 1 WHERE id = 1 RETURNING version').get() as { version: number }).version;
  const setPositions = (orderedIds: number[]) => {
    const update = db.prepare('UPDATE topics SET position = ? WHERE id = ?');
    orderedIds.forEach((id, index) => update.run(-(index + 1), id));
    orderedIds.forEach((id, index) => update.run(index + 1, id));
  };

  app.addHook('onClose', async () => db.close());

  app.addHook('onRequest', async (request, reply) => {
    const routePattern = request.routeOptions.url;
    const isVerify = request.method === 'POST' && routePattern === '/api/access/verify';
    if (isVerify) {
      reply.header('Cache-Control', 'no-store');
      if (!writeKey) return;
      const preflight = authRateLimiter.preflight(normalizeClientIp(request.ip));
      if (preflight.limited) {
        reply.header('Retry-After', String(preflight.retryAfter));
        return reply.code(429).send({ code: 'ACCESS_RATE_LIMITED', message: '尝试过于频繁，请稍后再试' });
      }
      return;
    }
    if (!writeKey) return;
    const sensitiveRead = ['GET', 'HEAD'].includes(request.method) && (
      routePattern === '/api/access/session'
      || routePattern === '/api/topics/:id/participants'
      || routePattern === '/api/topics/:id/meeting-access'
    );
    const businessWrite = ['POST', 'PATCH', 'DELETE'].includes(request.method)
      && !isVerify;
    if (!sensitiveRead && !businessWrite) return;
    const header = request.headers['x-fireside-session'];
    const sessionToken = Array.isArray(header) ? header[0] : header;
    const validation = validateCollaborationSession(sessionToken, writeKey, { now: authNow });
    if (!validation.valid) {
      reply.header('Cache-Control', 'no-store');
      return reply.code(401).send({ code: 'ACCESS_SESSION_REQUIRED', message: '协作会话已失效，请重新输入围炉口令' });
    }
    reply.header('Cache-Control', 'no-store');
    validatedSessions.set(request, { expiresAt: validation.expiresAt });
  });

  app.addHook('onRequest', async (request, reply) => {
    const routePattern = request.routeOptions.url;
    const isVerify = request.method === 'POST' && routePattern === '/api/access/verify';
    const businessWrite = ['POST', 'PATCH', 'DELETE'].includes(request.method) && !isVerify;
    if (!businessWrite || !options.businessWritesAllowed || options.businessWritesAllowed()) return;
    reply.header('Retry-After', '3');
    return reply.code(503).send({
      code: 'RELEASE_IN_PROGRESS',
      message: '炉火正在安全换班，请保留内容并稍后重试',
    });
  });

  app.addHook('preHandler', async (request, reply) => {
    const pathOnly = request.url.split('?')[0];
    const directMutation = ['PATCH', 'DELETE'].includes(request.method) && /^\/api\/topics\/\d+$/.test(pathOnly);
    const lifecycleMutation = request.method === 'POST'
      && /^\/api\/topics\/\d+\/(?:claim|release|schedule|unschedule|archive|unarchive)$/.test(pathOnly);
    if (!directMutation && !lifecycleMutation) return;
    const header = request.headers['if-match'];
    const candidate = Array.isArray(header) ? header.join(',') : header;
    if (candidate === undefined) {
      return reply.code(428).send({ code: 'TOPIC_REVISION_REQUIRED', message: '请刷新议题后再执行这个操作' });
    }
    const matched = /^"([1-9]\d*)"$/.exec(candidate);
    const revision = matched ? Number(matched[1]) : Number.NaN;
    if (!Number.isSafeInteger(revision)) {
      return reply.code(400).send({ code: 'INVALID_TOPIC_REVISION', message: '议题版本格式不正确' });
    }
    expectedRevisions.set(request, revision);
  });

  const expectedRevision = (request: FastifyRequest) => expectedRevisions.get(request)!;
  const topicCommandFailure = (reply: FastifyReply, id: number, revision: number, stateMessage: string) => {
    const latest = db.prepare('SELECT revision FROM topics WHERE id = ?').get(id) as { revision: number } | undefined;
    if (!latest) return reply.code(404).send({ code: 'TOPIC_NOT_FOUND', message: '没有找到这个议题' });
    if (latest.revision !== revision) {
      return reply.code(412).send({
        code: 'TOPIC_REVISION_CONFLICT',
        message: '议题已被其他协作者更新，本次操作未执行',
        currentRevision: latest.revision,
      });
    }
    return reply.code(409).send({ code: 'TOPIC_STATE_CONFLICT', message: stateMessage });
  };

  const activityTimeInvalid = (reply: FastifyReply, message = '活动排期时间不正确，请重新设置') => (
    reply.code(400).send({ code: 'ACTIVITY_TIME_INVALID', message })
  );
  const activityTimeConflict = (reply: FastifyReply, message: string, phase?: ActivityPhase | null) => (
    reply.code(409).send({
      code: 'ACTIVITY_TIME_CONFLICT',
      message,
      ...(phase ? { phase } : {}),
    })
  );

  app.get('/api/health', async () => ({
    ok: true,
    service: 'fireside',
    time: new Date().toISOString(),
    ...(options.releaseCommit ? { releaseCommit: options.releaseCommit } : {}),
  }));
  app.get('/api/access', async () => ({ enabled: Boolean(writeKey) }));
  app.post('/api/access/verify', async (request, reply) => {
    if (!writeKey) return reply.code(204).send();
    const source = normalizeClientIp(request.ip);
    const header = request.headers['x-fireside-write-key'];
    const encodingHeader = request.headers['x-fireside-write-key-encoding'];
    const candidate = decodeWriteKeyHeader(
      Array.isArray(header) ? undefined : header,
      Array.isArray(encodingHeader) ? undefined : encodingHeader,
    );
    if (!writeKeyMatches(candidate, writeKey)) {
      const recorded = authRateLimiter.recordFailure(source);
      if (recorded.limited) {
        reply.header('Retry-After', String(recorded.retryAfter));
        return reply.code(429).send({ code: 'ACCESS_RATE_LIMITED', message: '尝试过于频繁，请稍后再试' });
      }
      return reply.code(401).send({ code: 'ACCESS_REQUIRED', message: '围炉口令不正确' });
    }
    authRateLimiter.recordSuccess(source);
    return reply.code(200).send(issueCollaborationSession(writeKey, { now: authNow }));
  });
  app.get('/api/access/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!writeKey) return reply.code(204).send();
    return { valid: true, expiresAt: validatedSessions.get(request)!.expiresAt };
  });

  const toPublicTopic = (row: Parameters<typeof rowToTopic>[0]) => {
    const topic = rowToTopic(row);
    const legacyMeeting = analyzeMeetingRoom(topic.room);
    return {
      ...topic,
      room: legacyMeeting.publicRoom || null,
      meetingUrl: null,
      hasMeetingUrl: Boolean(topic.meetingUrl || legacyMeeting.meetingUrl),
    };
  };

  app.get('/api/topics', async (request, reply) => {
    const parsed = z.object({
      status: z.enum(['OPEN', 'CLAIMED', 'SCHEDULED', 'ARCHIVED']).optional(),
      sort: z.enum(['manual', 'newest', 'oldest', 'schedule', 'status']).default('manual'),
    }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: '状态筛选不正确' });
    const orderBy = {
      manual: 'position ASC, id ASC',
      newest: 'created_at DESC, id DESC',
      oldest: 'created_at ASC, id ASC',
      schedule: 'scheduled_at IS NULL, scheduled_at ASC, created_at DESC',
      status: "CASE status WHEN 'SCHEDULED' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'CLAIMED' THEN 2 ELSE 3 END, position ASC",
    }[parsed.data.sort];
    const where = parsed.data.status ? ' WHERE status = ?' : '';
    db.exec('BEGIN DEFERRED');
    let rows: unknown[];
    let orderVersion: number;
    try {
      rows = db.prepare(`
        SELECT topics.*,
          (SELECT COUNT(*) FROM topic_participants WHERE topic_id = topics.id) AS participant_count
        FROM topics${where} ORDER BY ${orderBy}
      `)
        .all(...(parsed.data.status ? [parsed.data.status] : []));
      if (options.afterTopicRowsRead) await options.afterTopicRowsRead();
      orderVersion = readOrderVersion();
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
    reply.header('X-Order-Version', String(orderVersion));
    return (rows as Parameters<typeof rowToTopic>[0][]).map(toPublicTopic);
  });

  app.get('/api/topics/:id', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const row = db.prepare(`
      SELECT topics.*,
        (SELECT COUNT(*) FROM topic_participants WHERE topic_id = topics.id) AS participant_count
      FROM topics WHERE id = ?
    `).get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
    return row
      ? toPublicTopic(row)
      : reply.code(404).send({ code: 'TOPIC_NOT_FOUND', message: '没有找到这个议题' });
  });

  app.get('/api/stats', async () => {
    const grouped = db.prepare('SELECT status, COUNT(*) AS count FROM topics GROUP BY status').all() as { status: string; count: number }[];
    const counts = Object.fromEntries(grouped.map(({ status, count }) => [status, count]));
    const next = db.prepare("SELECT * FROM topics WHERE status = 'SCHEDULED' AND scheduled_at >= ? ORDER BY scheduled_at ASC LIMIT 1").get(new Date().toISOString());
    return {
      open: counts.OPEN ?? 0,
      claimed: counts.CLAIMED ?? 0,
      scheduled: counts.SCHEDULED ?? 0,
      archived: counts.ARCHIVED ?? 0,
      nextTopic: next ? toPublicTopic(next as Parameters<typeof rowToTopic>[0]) : null,
    };
  });

  app.post('/api/topics', async (request, reply) => {
    const parsed = createTopicSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: validationMessage(parsed.error) });
    const now = new Date().toISOString();
    const topic = db.transaction(() => {
      const { nextPosition } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS nextPosition FROM topics').get() as { nextPosition: number };
      const status = parsed.data.presenter ? 'CLAIMED' : 'OPEN';
      const result = db.prepare(`
        INSERT INTO topics (position, title, summary, proposer, presenter, tags, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nextPosition, parsed.data.title, parsed.data.summary, parsed.data.proposer, parsed.data.presenter ?? null, JSON.stringify(parsed.data.tags), status, now, now);
      bumpOrderVersion();
      return db.prepare('SELECT * FROM topics WHERE id = ?').get(result.lastInsertRowid);
    }).immediate();
    reply.header('X-Order-Version', String(readOrderVersion()));
    return reply.code(201).send(toPublicTopic(topic as Parameters<typeof rowToTopic>[0]));
  });

  app.patch('/api/topics/:id', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = editTopicSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const actionNow = captureNow();
    if (body.data.room !== undefined && analyzeMeetingRoom(body.data.room).sensitive) {
      return reply.code(400).send({ code: 'SENSITIVE_ROOM_CONTENT', message: sensitiveRoomMessage });
    }
    const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!row) return reply.code(404).send({ code: 'TOPIC_NOT_FOUND', message: '没有找到这个议题' });
    const current = rowToTopic(row);
    const revision = expectedRevision(request);
    if (current.revision !== revision) {
      return topicCommandFailure(reply, params.data.id, revision, '当前状态不能修改这些字段，请按议题流程操作');
    }
    const fieldsByStatus = {
      OPEN: ['presenter', 'scheduledAt', 'duration', 'room', 'meetingUrl', 'takeaway', 'materialUrl'],
      CLAIMED: ['scheduledAt', 'duration', 'room', 'meetingUrl', 'takeaway', 'materialUrl'],
      SCHEDULED: ['takeaway', 'materialUrl'],
      ARCHIVED: [],
    } as const;
    if (fieldsByStatus[current.status].some((field) => field in body.data)) {
      return reply.code(409).send({ code: 'TOPIC_STATE_CONFLICT', message: '当前状态不能修改这些字段，请按议题流程操作' });
    }
    if (current.status === 'SCHEDULED' && ('scheduledAt' in body.data || 'duration' in body.data)) {
      const phase = activityPhase(current.scheduledAt, current.duration, actionNow);
      if (!phase) return activityTimeInvalid(reply, '当前活动排期数据不完整，暂时不能改期');
      if (phase !== 'UPCOMING') {
        return activityTimeConflict(reply, phase === 'LIVE' ? '活动进行中，不能改期或更改时长' : '分享已结束，不能直接改期或更改时长', phase);
      }
      const nextScheduledAt = body.data.scheduledAt ?? current.scheduledAt;
      const nextStart = nextScheduledAt ? new Date(nextScheduledAt).getTime() : Number.NaN;
      if (!Number.isFinite(nextStart) || !Number.isFinite(actionNow.getTime()) || nextStart <= actionNow.getTime()) {
        return activityTimeInvalid(reply, '新的分享时间必须晚于当前时间');
      }
    }
    await options.beforeTopicUpdate?.();
    const updates: { column: string; value: unknown }[] = [];
    if (body.data.title !== undefined) updates.push({ column: 'title', value: body.data.title });
    if (body.data.summary !== undefined) updates.push({ column: 'summary', value: body.data.summary });
    if (body.data.proposer !== undefined) updates.push({ column: 'proposer', value: body.data.proposer });
    if (body.data.presenter !== undefined) updates.push({ column: 'presenter', value: body.data.presenter });
    if (body.data.tags !== undefined) updates.push({ column: 'tags', value: JSON.stringify(body.data.tags) });
    if (body.data.scheduledAt !== undefined) updates.push({ column: 'scheduled_at', value: body.data.scheduledAt });
    if (body.data.duration !== undefined) updates.push({ column: 'duration', value: body.data.duration });
    if (body.data.room !== undefined) updates.push({ column: 'room', value: body.data.room });
    if (body.data.meetingUrl !== undefined) updates.push({ column: 'meeting_url', value: body.data.meetingUrl || null });
    if (body.data.takeaway !== undefined) updates.push({ column: 'takeaway', value: body.data.takeaway });
    if (body.data.materialUrl !== undefined) updates.push({ column: 'material_url', value: body.data.materialUrl || null });
    updates.push({ column: 'updated_at', value: actionNow.toISOString() });
    const requiresStateMatch = Object.keys(body.data).some((field) => stateRestrictedEditFields.has(field));
    const updated = db.prepare(`
      UPDATE topics SET ${updates.map(({ column }) => `${column} = ?`).join(', ')}, revision = revision + 1
      WHERE id = ? AND revision = ?${requiresStateMatch ? ' AND status = ?' : ''}
      RETURNING *
    `).get(...updates.map(({ value }) => value), params.data.id, revision, ...(requiresStateMatch ? [current.status] : [])) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!updated) return topicCommandFailure(reply, params.data.id, revision, '议题状态已变化，请重新确认后再编辑');
    return toPublicTopic(updated);
  });

  app.delete('/api/topics/:id', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const revision = expectedRevision(request);
    const outcome = db.transaction(() => {
      const current = db.prepare(`
        SELECT revision, status, scheduled_at, duration, room, meeting_url,
          takeaway, material_url, archived_at,
          (SELECT COUNT(*) FROM topic_participants WHERE topic_id = topics.id) AS participant_count
        FROM topics WHERE id = ?
      `).get(params.data.id) as {
        revision: number;
        status: 'OPEN' | 'CLAIMED' | 'SCHEDULED' | 'ARCHIVED';
        scheduled_at: string | null;
        duration: number | null;
        room: string | null;
        meeting_url: string | null;
        takeaway: string | null;
        material_url: string | null;
        archived_at: string | null;
        participant_count: number;
      } | undefined;
      if (!current) return { status: 'missing' as const };
      if (current.revision !== revision) {
        return { status: 'conflict' as const, currentRevision: current.revision };
      }
      const hasMatureDependency = current.scheduled_at !== null
        || current.duration !== null
        || current.room !== null
        || current.meeting_url !== null
        || current.takeaway !== null
        || current.material_url !== null
        || current.archived_at !== null
        || current.participant_count > 0;
      if (!['OPEN', 'CLAIMED'].includes(current.status) || hasMatureDependency) {
        return {
          status: 'state-conflict' as const,
          currentRevision: current.revision,
          currentStatus: current.status,
        };
      }
      const result = db.prepare(`
        DELETE FROM topics
        WHERE id = ? AND revision = ? AND status IN ('OPEN', 'CLAIMED')
          AND scheduled_at IS NULL AND duration IS NULL AND room IS NULL
          AND meeting_url IS NULL AND takeaway IS NULL AND material_url IS NULL
          AND archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM topic_participants WHERE topic_id = topics.id)
      `).run(params.data.id, revision);
      if (result.changes !== 1) {
        return {
          status: 'state-conflict' as const,
          currentRevision: current.revision,
          currentStatus: current.status,
        };
      }
      const remainingIds = (db.prepare('SELECT id FROM topics ORDER BY position ASC, id ASC').all() as { id: number }[]).map(({ id }) => id);
      setPositions(remainingIds);
      return { status: 'deleted' as const, orderVersion: bumpOrderVersion() };
    }).immediate();
    if (outcome.status === 'missing') return reply.code(404).send({ code: 'TOPIC_NOT_FOUND', message: '没有找到这个议题' });
    if (outcome.status === 'conflict') {
      return reply.code(412).send({ code: 'TOPIC_REVISION_CONFLICT', message: '议题已被其他协作者更新，本次未删除', currentRevision: outcome.currentRevision });
    }
    if (outcome.status === 'state-conflict') {
      const message = outcome.currentStatus === 'ARCHIVED'
        ? '归档记录不能直接删除；如为误归档，请先撤销归档'
        : outcome.currentStatus === 'SCHEDULED'
          ? '已排期议题不能直接删除，请先按活动实际情况取消排期或标记未举行'
          : '这个议题包含排期、报名或归档信息，不能直接永久删除';
      return reply.code(409).send({
        code: 'TOPIC_DELETE_STATE_CONFLICT',
        message,
        currentRevision: outcome.currentRevision,
        currentStatus: outcome.currentStatus,
      });
    }
    await options.afterTopicDeleteCommit?.();
    reply.header('X-Order-Version', String(outcome.orderVersion));
    return reply.code(204).send();
  });

  app.post('/api/topics/reorder', async (request, reply) => {
    const body = reorderSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: validationMessage(body.error) });
    const outcome = db.transaction(() => {
      const currentVersion = readOrderVersion();
      if (currentVersion !== body.data.baseVersion) return { status: 'conflict' as const, version: currentVersion };
      const existing = db.prepare('SELECT id FROM topics ORDER BY position ASC, id ASC').all() as { id: number }[];
      if (existing.length !== body.data.orderedIds.length || existing.some(({ id }) => !body.data.orderedIds.includes(id))) {
        return { status: 'invalid' as const, version: currentVersion };
      }
      setPositions(body.data.orderedIds);
      return { status: 'ok' as const, version: bumpOrderVersion() };
    }).immediate();
    reply.header('X-Order-Version', String(outcome.version));
    if (outcome.status === 'conflict') {
      return reply.code(409).send({ message: '议题顺序已被其他操作更新，请同步后重试' });
    }
    if (outcome.status === 'invalid') {
      return reply.code(400).send({ message: '排序列表需要包含全部议题' });
    }
    return reply.code(204).send();
  });

  app.post('/api/topics/:id/claim', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = claimSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const revision = expectedRevision(request);
    const updated = db.prepare(`
      UPDATE topics SET presenter = ?, status = 'CLAIMED', updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'OPEN' AND revision = ? RETURNING *
    `).get(body.data.presenter, new Date().toISOString(), params.data.id, revision) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!updated) return topicCommandFailure(reply, params.data.id, revision, '这个议题已经被认领或排期');
    return toPublicTopic(updated);
  });

  app.post('/api/topics/:id/release', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const revision = expectedRevision(request);
    const updated = db.prepare(`
      UPDATE topics SET presenter = NULL, status = 'OPEN', updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'CLAIMED' AND revision = ? RETURNING *
    `).get(new Date().toISOString(), params.data.id, revision) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!updated) return topicCommandFailure(reply, params.data.id, revision, '只有准备中的议题可以重新开放认领');
    return toPublicTopic(updated);
  });

  app.post('/api/topics/:id/schedule', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = scheduleSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const actionNow = captureNow();
    const revision = expectedRevision(request);
    const currentRow = db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!currentRow || currentRow.revision !== revision || currentRow.status !== 'CLAIMED') {
      return topicCommandFailure(reply, params.data.id, revision, '议题需要先被认领，才能安排分享');
    }
    if (analyzeMeetingRoom(body.data.room).sensitive) {
      return reply.code(400).send({ code: 'SENSITIVE_ROOM_CONTENT', message: sensitiveRoomMessage });
    }
    const nextStart = new Date(body.data.scheduledAt).getTime();
    if (!Number.isFinite(nextStart) || !Number.isFinite(actionNow.getTime()) || nextStart <= actionNow.getTime()) {
      return activityTimeInvalid(reply, '分享时间必须晚于当前时间');
    }
    const updated = db.prepare(`
      UPDATE topics
      SET scheduled_at = ?, duration = ?, room = ?, meeting_url = ?, status = 'SCHEDULED', updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'CLAIMED' AND revision = ? RETURNING *
    `).get(body.data.scheduledAt, body.data.duration, body.data.room, body.data.meetingUrl || null, actionNow.toISOString(), params.data.id, revision) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!updated) return topicCommandFailure(reply, params.data.id, revision, '议题需要先被认领，才能安排分享');
    return toPublicTopic(updated);
  });

  app.post('/api/topics/:id/unschedule', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const revision = expectedRevision(request);
    const outcome = db.transaction(() => {
      const actionNow = captureNow();
      const currentRow = db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
      if (!currentRow) return { status: 'missing' as const };
      const current = rowToTopic(currentRow);
      if (current.revision !== revision) return { status: 'revision-conflict' as const, currentRevision: current.revision };
      if (current.status !== 'SCHEDULED') return { status: 'state-conflict' as const };
      const phase = activityPhase(current.scheduledAt, current.duration, actionNow);
      if (!phase) return { status: 'invalid-time' as const };
      if (phase === 'LIVE') return { status: 'time-conflict' as const, phase };
      const updated = db.prepare(`
        UPDATE topics
        SET scheduled_at = NULL, duration = NULL, room = NULL, meeting_url = NULL,
            status = 'CLAIMED', updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'SCHEDULED' AND revision = ? RETURNING *
      `).get(actionNow.toISOString(), params.data.id, revision) as Parameters<typeof rowToTopic>[0] | undefined;
      if (!updated) return { status: 'state-conflict' as const };
      db.prepare('DELETE FROM topic_participants WHERE topic_id = ?').run(params.data.id);
      return { status: 'ok' as const, topic: updated };
    }).immediate();
    if (outcome.status === 'missing') return reply.code(404).send({ code: 'TOPIC_NOT_FOUND', message: '没有找到这个议题' });
    if (outcome.status === 'revision-conflict') {
      return reply.code(412).send({
        code: 'TOPIC_REVISION_CONFLICT',
        message: '议题已被其他协作者更新，本次操作未执行',
        currentRevision: outcome.currentRevision,
      });
    }
    if (outcome.status === 'state-conflict') {
      return reply.code(409).send({ code: 'TOPIC_STATE_CONFLICT', message: '只有已排期的议题可以取消排期' });
    }
    if (outcome.status === 'invalid-time') return activityTimeInvalid(reply, '当前活动排期数据不完整，暂时不能取消排期');
    if (outcome.status === 'time-conflict') return activityTimeConflict(reply, '活动进行中，不能取消排期', outcome.phase);
    return toPublicTopic(outcome.topic);
  });

  app.post('/api/topics/:id/archive', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = archiveSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const actionNow = captureNow();
    const revision = expectedRevision(request);
    const currentRow = db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!currentRow || currentRow.revision !== revision || currentRow.status !== 'SCHEDULED') {
      return topicCommandFailure(reply, params.data.id, revision, '只有已结束的排期议题可以归档');
    }
    const current = rowToTopic(currentRow);
    const phase = activityPhase(current.scheduledAt, current.duration, actionNow);
    if (!phase) return activityTimeInvalid(reply, '当前活动排期数据不完整，暂时不能归档');
    if (phase !== 'ENDED') {
      return activityTimeConflict(reply, phase === 'LIVE' ? '活动仍在进行中，结束后才能归档' : '活动尚未开始，不能提前归档', phase);
    }
    const nowIso = actionNow.toISOString();
    const updated = db.prepare(`
      UPDATE topics SET takeaway = ?, material_url = ?, status = 'ARCHIVED', archived_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'SCHEDULED' AND revision = ? RETURNING *
    `).get(body.data.takeaway, body.data.materialUrl || null, nowIso, nowIso, params.data.id, revision) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!updated) return topicCommandFailure(reply, params.data.id, revision, '只有已结束的排期议题可以归档');
    return toPublicTopic(updated);
  });

  app.post('/api/topics/:id/unarchive', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const revision = expectedRevision(request);
    const updated = db.prepare(`
      UPDATE topics
      SET takeaway = NULL, material_url = NULL, archived_at = NULL, status = 'SCHEDULED', updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'ARCHIVED' AND revision = ? RETURNING *
    `).get(new Date().toISOString(), params.data.id, revision) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!updated) return topicCommandFailure(reply, params.data.id, revision, '只有已归档的议题可以撤销归档');
    return toPublicTopic(updated);
  });

  app.get('/api/topics/:id/meeting-access', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const actionNow = captureNow();
    const row = db.prepare('SELECT status, scheduled_at, duration, room, meeting_url FROM topics WHERE id = ?').get(params.data.id) as {
      status: string;
      scheduled_at: string | null;
      duration: number | null;
      room: string | null;
      meeting_url: string | null;
    } | undefined;
    if (!row) return reply.code(404).send({ message: '没有找到这个议题' });
    if (row.status !== 'SCHEDULED') return activityTimeConflict(reply, '当前议题没有开放中的会议入口');
    const phase = activityPhase(row.scheduled_at, row.duration, actionNow);
    if (!phase) return activityTimeInvalid(reply, '当前活动排期数据不完整，无法打开会议入口');
    if (phase === 'ENDED') return activityTimeConflict(reply, '分享已结束，会议入口已经关闭', phase);
    const meetingUrl = row.meeting_url || analyzeMeetingRoom(row.room).meetingUrl;
    return meetingUrl
      ? { meetingUrl }
      : activityTimeConflict(reply, '这个议题没有可用的线上会议入口', phase);
  });

  app.get('/api/topics/:id/participants', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const exists = db.prepare('SELECT 1 FROM topics WHERE id = ?').get(params.data.id);
    if (!exists) return reply.code(404).send({ message: '没有找到这个议题' });
    const rows = db.prepare('SELECT id, topic_id, name, created_at FROM topic_participants WHERE topic_id = ? ORDER BY id ASC')
      .all(params.data.id) as { id: number; topic_id: number; name: string; created_at: string }[];
    return rows.map((row) => ({ id: row.id, topicId: row.topic_id, name: row.name, createdAt: row.created_at }));
  });

  app.post('/api/topics/:id/participants', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = participantSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const normalizedName = body.data.name.toLocaleLowerCase('zh-CN');
    const outcome = db.transaction(() => {
      const actionNow = captureNow();
      const topic = db.prepare('SELECT status, scheduled_at, duration FROM topics WHERE id = ?').get(params.data.id) as {
        status: string;
        scheduled_at: string | null;
        duration: number | null;
      } | undefined;
      if (!topic) return { status: 'missing' as const };
      if (topic.status !== 'SCHEDULED') return { status: 'invalid' as const };
      const phase = activityPhase(topic.scheduled_at, topic.duration, actionNow);
      if (!phase) return { status: 'invalid-time' as const };
      if (phase === 'ENDED') return { status: 'time-conflict' as const, phase };
      const duplicate = db.prepare('SELECT 1 FROM topic_participants WHERE topic_id = ? AND normalized_name = ?')
        .get(params.data.id, normalizedName);
      if (duplicate) return { status: 'duplicate' as const };
      const nowIso = actionNow.toISOString();
      const result = db.prepare('INSERT INTO topic_participants (topic_id, name, normalized_name, created_at) VALUES (?, ?, ?, ?)')
        .run(params.data.id, body.data.name, normalizedName, nowIso);
      db.prepare('UPDATE topics SET revision = revision + 1, updated_at = ? WHERE id = ?').run(nowIso, params.data.id);
      return { status: 'ok' as const, participant: { id: Number(result.lastInsertRowid), topicId: params.data.id, name: body.data.name, createdAt: nowIso } };
    }).immediate();
    if (outcome.status === 'missing') return reply.code(404).send({ message: '没有找到这个议题' });
    if (outcome.status === 'invalid') return reply.code(409).send({ code: 'TOPIC_STATE_CONFLICT', message: '只有已排期的议题可以报名' });
    if (outcome.status === 'invalid-time') return activityTimeInvalid(reply, '当前活动排期数据不完整，暂时不能报名');
    if (outcome.status === 'time-conflict') return activityTimeConflict(reply, '分享已结束，报名名单已经冻结', outcome.phase);
    if (outcome.status === 'duplicate') return reply.code(409).send({ code: 'PARTICIPANT_DUPLICATE', message: '这个名字已经报名，请勿重复提交' });
    return reply.code(201).send(outcome.participant);
  });

  app.delete('/api/topics/:id/participants/:participantId', async (request, reply) => {
    const params = z.object({
      id: z.coerce.number().int().positive(),
      participantId: z.coerce.number().int().positive(),
    }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '参与记录编号不正确' });
    const outcome = db.transaction(() => {
      const actionNow = captureNow();
      const topic = db.prepare('SELECT status, scheduled_at, duration FROM topics WHERE id = ?').get(params.data.id) as {
        status: string;
        scheduled_at: string | null;
        duration: number | null;
      } | undefined;
      if (!topic) return 'missing-topic' as const;
      if (topic.status !== 'SCHEDULED') return 'invalid' as const;
      const phase = activityPhase(topic.scheduled_at, topic.duration, actionNow);
      if (!phase) return 'invalid-time' as const;
      if (phase === 'ENDED') return 'time-conflict' as const;
      const result = db.prepare('DELETE FROM topic_participants WHERE id = ? AND topic_id = ?')
        .run(params.data.participantId, params.data.id);
      if (result.changes !== 1) return 'missing-participant' as const;
      db.prepare('UPDATE topics SET revision = revision + 1, updated_at = ? WHERE id = ?').run(actionNow.toISOString(), params.data.id);
      return 'ok' as const;
    }).immediate();
    if (outcome === 'missing-topic') return reply.code(404).send({ message: '没有找到这个议题' });
    if (outcome === 'invalid') return reply.code(409).send({ code: 'TOPIC_STATE_CONFLICT', message: '活动已结束或取消，不能修改报名' });
    if (outcome === 'invalid-time') return activityTimeInvalid(reply, '当前活动排期数据不完整，暂时不能修改报名');
    if (outcome === 'time-conflict') return activityTimeConflict(reply, '分享已结束，报名名单已经冻结', 'ENDED');
    if (outcome === 'missing-participant') return reply.code(404).send({ message: '没有找到这条报名记录' });
    return reply.code(204).send();
  });

  app.setErrorHandler((error, request, reply) => {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
    const parserResponse = parserErrorResponses[errorCode as keyof typeof parserErrorResponses];
    if (parserResponse) {
      if (request.routeOptions.url === '/api/access/verify') reply.header('Cache-Control', 'no-store');
      return reply.code(parserResponse.status).send({ code: parserResponse.code, message: parserResponse.message });
    }
    app.log.error(error);
    return reply.code(500).send({ message: '炉火晃了一下，请稍后再试' });
  });

  if (options.serveStatic ?? true) {
    app.register(fastifyStatic, {
      root: path.join(projectRoot, 'dist'),
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ message: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
