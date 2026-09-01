import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { writeKeyMatches } from './access.js';
import { createDatabase, rowToTopic } from './db.js';
import { analyzeMeetingRoom } from './meeting.js';
import type { Topic } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

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
  writeKey?: string;
  serveStatic?: boolean;
  beforeTopicUpdate?: () => Promise<void>;
  afterTopicRowsRead?: () => Promise<void>;
};

function validationMessage(error: z.ZodError) {
  return error.issues[0]?.message ?? '提交内容不正确';
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: options.logger ? { redact: ['req.headers.x-fireside-write-key'] } : false,
  });
  const writeKey = options.writeKey ?? process.env.FIRESIDE_WRITE_KEY ?? '';
  const databasePath = options.databasePath ?? process.env.DATABASE_PATH ?? path.join(projectRoot, 'data', 'fireside.db');
  const db = createDatabase(databasePath, options.seed ?? true);
  const readOrderVersion = () => (db.prepare('SELECT version FROM topic_order_state WHERE id = 1').get() as { version: number }).version;
  const bumpOrderVersion = () => db.prepare('UPDATE topic_order_state SET version = version + 1 WHERE id = 1').run();
  const setPositions = (orderedIds: number[]) => {
    const update = db.prepare('UPDATE topics SET position = ?, updated_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    orderedIds.forEach((id, index) => update.run(-(index + 1), now, id));
    orderedIds.forEach((id, index) => update.run(index + 1, now, id));
  };

  app.addHook('onClose', async () => db.close());

  app.addHook('onRequest', async (request, reply) => {
    if (!writeKey) return;
    const pathOnly = request.url.split('?')[0];
    const sensitiveRead = request.method === 'GET' && /^\/api\/topics\/\d+\/(?:participants|meeting-access)$/.test(pathOnly);
    const businessWrite = ['POST', 'PATCH', 'DELETE'].includes(request.method)
      && pathOnly !== '/api/access/verify';
    if (!sensitiveRead && !businessWrite) return;
    const header = request.headers['x-fireside-write-key'];
    const candidate = Array.isArray(header) ? header[0] : header;
    if (!writeKeyMatches(candidate, writeKey)) {
      return reply.code(401).send({ code: 'ACCESS_REQUIRED', message: '需要正确的围炉口令才能继续协作' });
    }
  });

  app.get('/api/health', async () => ({ ok: true, service: 'fireside', time: new Date().toISOString() }));
  app.get('/api/access', async () => ({ enabled: Boolean(writeKey) }));
  app.post('/api/access/verify', async (request, reply) => {
    if (!writeKey) return reply.code(204).send();
    const header = request.headers['x-fireside-write-key'];
    const candidate = Array.isArray(header) ? header[0] : header;
    return writeKeyMatches(candidate, writeKey)
      ? reply.code(204).send()
      : reply.code(401).send({ code: 'ACCESS_REQUIRED', message: '围炉口令不正确' });
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
    if (body.data.room !== undefined && analyzeMeetingRoom(body.data.room).sensitive) {
      return reply.code(400).send({ code: 'SENSITIVE_ROOM_CONTENT', message: sensitiveRoomMessage });
    }
    const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!row) return reply.code(404).send({ message: '没有找到这个议题' });
    const current = rowToTopic(row);
    const fieldsByStatus = {
      OPEN: ['presenter', 'scheduledAt', 'duration', 'room', 'meetingUrl', 'takeaway', 'materialUrl'],
      CLAIMED: ['scheduledAt', 'duration', 'room', 'meetingUrl', 'takeaway', 'materialUrl'],
      SCHEDULED: ['takeaway', 'materialUrl'],
      ARCHIVED: [],
    } as const;
    if (fieldsByStatus[current.status].some((field) => field in body.data)) {
      return reply.code(409).send({ code: 'TOPIC_STATE_CONFLICT', message: '当前状态不能修改这些字段，请按议题流程操作' });
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
    updates.push({ column: 'updated_at', value: new Date().toISOString() });
    const requiresStateMatch = Object.keys(body.data).some((field) => stateRestrictedEditFields.has(field));
    const result = db.prepare(`UPDATE topics SET ${updates.map(({ column }) => `${column} = ?`).join(', ')} WHERE id = ?${requiresStateMatch ? ' AND status = ?' : ''}`)
      .run(...updates.map(({ value }) => value), params.data.id, ...(requiresStateMatch ? [current.status] : []));
    if (result.changes === 0) {
      const exists = db.prepare('SELECT 1 FROM topics WHERE id = ?').get(params.data.id);
      return exists
        ? reply.code(409).send({ code: 'TOPIC_STATE_CONFLICT', message: '议题状态已变化，已同步最新结果，请重新确认后再编辑' })
        : reply.code(404).send({ message: '没有找到这个议题' });
    }
    return toPublicTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.delete('/api/topics/:id', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const deleted = db.transaction(() => {
      const result = db.prepare('DELETE FROM topics WHERE id = ?').run(params.data.id);
      if (result.changes === 0) return false;
      const remainingIds = (db.prepare('SELECT id FROM topics ORDER BY position ASC, id ASC').all() as { id: number }[]).map(({ id }) => id);
      setPositions(remainingIds);
      bumpOrderVersion();
      return true;
    }).immediate();
    if (!deleted) return reply.code(404).send({ message: '没有找到这个议题' });
    reply.header('X-Order-Version', String(readOrderVersion()));
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
      bumpOrderVersion();
      return { status: 'ok' as const, version: currentVersion + 1 };
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
    const result = db.prepare("UPDATE topics SET presenter = ?, status = 'CLAIMED', updated_at = ? WHERE id = ? AND status = 'OPEN'")
      .run(body.data.presenter, new Date().toISOString(), params.data.id);
    if (result.changes === 0) {
      const exists = db.prepare('SELECT 1 FROM topics WHERE id = ?').get(params.data.id);
      return exists
        ? reply.code(409).send({ message: '这个议题已经被认领或排期' })
        : reply.code(404).send({ message: '没有找到这个议题' });
    }
    return toPublicTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.post('/api/topics/:id/release', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const result = db.prepare("UPDATE topics SET presenter = NULL, status = 'OPEN', updated_at = ? WHERE id = ? AND status = 'CLAIMED'")
      .run(new Date().toISOString(), params.data.id);
    if (result.changes === 0) {
      const exists = db.prepare('SELECT 1 FROM topics WHERE id = ?').get(params.data.id);
      return exists
        ? reply.code(409).send({ message: '只有准备中的议题可以重新开放认领' })
        : reply.code(404).send({ message: '没有找到这个议题' });
    }
    return toPublicTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.post('/api/topics/:id/schedule', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = scheduleSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    if (analyzeMeetingRoom(body.data.room).sensitive) {
      return reply.code(400).send({ code: 'SENSITIVE_ROOM_CONTENT', message: sensitiveRoomMessage });
    }
    const result = db.prepare("UPDATE topics SET scheduled_at = ?, duration = ?, room = ?, meeting_url = ?, status = 'SCHEDULED', updated_at = ? WHERE id = ? AND status = 'CLAIMED'")
      .run(body.data.scheduledAt, body.data.duration, body.data.room, body.data.meetingUrl || null, new Date().toISOString(), params.data.id);
    if (result.changes === 0) {
      const exists = db.prepare('SELECT 1 FROM topics WHERE id = ?').get(params.data.id);
      return exists
        ? reply.code(409).send({ message: '议题需要先被认领，才能安排分享' })
        : reply.code(404).send({ message: '没有找到这个议题' });
    }
    return toPublicTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.post('/api/topics/:id/unschedule', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const outcome = db.transaction(() => {
      const result = db.prepare(`
        UPDATE topics
        SET scheduled_at = NULL, duration = NULL, room = NULL, meeting_url = NULL, status = 'CLAIMED', updated_at = ?
        WHERE id = ? AND status = 'SCHEDULED'
      `).run(new Date().toISOString(), params.data.id);
      if (result.changes === 0) return false;
      db.prepare('DELETE FROM topic_participants WHERE topic_id = ?').run(params.data.id);
      return true;
    }).immediate();
    if (!outcome) {
      const exists = db.prepare('SELECT 1 FROM topics WHERE id = ?').get(params.data.id);
      return exists
        ? reply.code(409).send({ message: '只有已排期的议题可以取消排期' })
        : reply.code(404).send({ message: '没有找到这个议题' });
    }
    return toPublicTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.post('/api/topics/:id/archive', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = archiveSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const now = new Date().toISOString();
    const result = db.prepare("UPDATE topics SET takeaway = ?, material_url = ?, status = 'ARCHIVED', archived_at = ?, updated_at = ? WHERE id = ? AND status = 'SCHEDULED'")
      .run(body.data.takeaway, body.data.materialUrl || null, now, now, params.data.id);
    if (result.changes === 0) {
      const exists = db.prepare('SELECT 1 FROM topics WHERE id = ?').get(params.data.id);
      return exists
        ? reply.code(409).send({ message: '只有已排期的议题可以归档' })
        : reply.code(404).send({ message: '没有找到这个议题' });
    }
    return toPublicTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.post('/api/topics/:id/unarchive', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const result = db.prepare(`
      UPDATE topics
      SET takeaway = NULL, material_url = NULL, archived_at = NULL, status = 'SCHEDULED', updated_at = ?
      WHERE id = ? AND status = 'ARCHIVED'
    `).run(new Date().toISOString(), params.data.id);
    if (result.changes === 0) {
      const exists = db.prepare('SELECT 1 FROM topics WHERE id = ?').get(params.data.id);
      return exists
        ? reply.code(409).send({ message: '只有已归档的议题可以撤销归档' })
        : reply.code(404).send({ message: '没有找到这个议题' });
    }
    return toPublicTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.get('/api/topics/:id/meeting-access', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const row = db.prepare('SELECT room, meeting_url FROM topics WHERE id = ?').get(params.data.id) as { room: string | null; meeting_url: string | null } | undefined;
    if (!row) return reply.code(404).send({ message: '没有找到这个议题' });
    const meetingUrl = row.meeting_url || analyzeMeetingRoom(row.room).meetingUrl;
    return meetingUrl
      ? { meetingUrl }
      : reply.code(404).send({ message: '这个议题没有线上会议入口' });
  });

  app.get('/api/topics/:id/participants', async (request, reply) => {
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
      const topic = db.prepare('SELECT status FROM topics WHERE id = ?').get(params.data.id) as { status: string } | undefined;
      if (!topic) return { status: 'missing' as const };
      if (topic.status !== 'SCHEDULED') return { status: 'invalid' as const };
      const duplicate = db.prepare('SELECT 1 FROM topic_participants WHERE topic_id = ? AND normalized_name = ?')
        .get(params.data.id, normalizedName);
      if (duplicate) return { status: 'duplicate' as const };
      const now = new Date().toISOString();
      const result = db.prepare('INSERT INTO topic_participants (topic_id, name, normalized_name, created_at) VALUES (?, ?, ?, ?)')
        .run(params.data.id, body.data.name, normalizedName, now);
      return { status: 'ok' as const, participant: { id: Number(result.lastInsertRowid), topicId: params.data.id, name: body.data.name, createdAt: now } };
    }).immediate();
    if (outcome.status === 'missing') return reply.code(404).send({ message: '没有找到这个议题' });
    if (outcome.status === 'invalid') return reply.code(409).send({ code: 'TOPIC_STATE_CONFLICT', message: '只有已排期的议题可以报名' });
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
      const topic = db.prepare('SELECT status FROM topics WHERE id = ?').get(params.data.id) as { status: string } | undefined;
      if (!topic) return 'missing-topic' as const;
      if (topic.status !== 'SCHEDULED') return 'invalid' as const;
      const result = db.prepare('DELETE FROM topic_participants WHERE id = ? AND topic_id = ?')
        .run(params.data.participantId, params.data.id);
      return result.changes === 1 ? 'ok' as const : 'missing-participant' as const;
    }).immediate();
    if (outcome === 'missing-topic') return reply.code(404).send({ message: '没有找到这个议题' });
    if (outcome === 'invalid') return reply.code(409).send({ code: 'TOPIC_STATE_CONFLICT', message: '活动已结束或取消，不能修改报名' });
    if (outcome === 'missing-participant') return reply.code(404).send({ message: '没有找到这条报名记录' });
    return reply.code(204).send();
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.code(500).send({ message: '炉火晃了一下，请稍后再试' });
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
