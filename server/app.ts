import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createDatabase, rowToTopic } from './db.js';
import type { Topic } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const nonEmptyText = (label: string, max = 120) => z.string().trim().min(1, `${label}不能为空`).max(max, `${label}不能超过 ${max} 个字符`);
const createTopicSchema = z.object({
  title: nonEmptyText('议题标题', 80),
  summary: nonEmptyText('议题简介', 500),
  proposer: nonEmptyText('发起人', 30),
  tags: z.array(z.string().trim().min(1).max(20)).max(5).default([]),
});
const claimSchema = z.object({ presenter: nonEmptyText('认领人', 30) });
const scheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  duration: z.number().int().min(10).max(240),
  room: nonEmptyText('地点', 60),
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
  tags: z.array(z.string().trim().min(1).max(20)).max(5).optional(),
  presenter: nonEmptyText('分享人', 30).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  duration: z.number().int().min(10).max(240).optional(),
  room: nonEmptyText('地点', 60).optional(),
  takeaway: nonEmptyText('本期收获', 1000).optional(),
  materialUrl: z.union([
    z.literal(''),
    z.string().url('资料链接格式不正确').refine((value) => /^https?:\/\//i.test(value), '资料链接仅支持 http 或 https'),
  ]).optional(),
}).refine((value) => Object.keys(value).length > 0, '至少需要修改一项内容');
const reorderSchema = z.object({
  orderedIds: z.array(z.number().int().positive()).min(1).refine((ids) => new Set(ids).size === ids.length, '排序列表不能包含重复议题'),
});

type AppOptions = {
  databasePath?: string;
  seed?: boolean;
  logger?: boolean;
  serveStatic?: boolean;
};

function validationMessage(error: z.ZodError) {
  return error.issues[0]?.message ?? '提交内容不正确';
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });
  const databasePath = options.databasePath ?? process.env.DATABASE_PATH ?? path.join(projectRoot, 'data', 'fireside.db');
  const db = createDatabase(databasePath, options.seed ?? true);

  app.addHook('onClose', async () => db.close());

  app.get('/api/health', async () => ({ ok: true, service: 'fireside', time: new Date().toISOString() }));

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
    const rows = db.prepare(`SELECT * FROM topics${where} ORDER BY ${orderBy}`)
      .all(...(parsed.data.status ? [parsed.data.status] : []));
    return (rows as Parameters<typeof rowToTopic>[0][]).map(rowToTopic);
  });

  app.get('/api/stats', async () => {
    const grouped = db.prepare('SELECT status, COUNT(*) AS count FROM topics GROUP BY status').all() as { status: string; count: number }[];
    const counts = Object.fromEntries(grouped.map(({ status, count }) => [status, count]));
    const next = db.prepare("SELECT * FROM topics WHERE status = 'SCHEDULED' AND scheduled_at >= ? ORDER BY scheduled_at ASC LIMIT 1").get(new Date().toISOString());
    return {
      open: (counts.OPEN ?? 0) + (counts.CLAIMED ?? 0),
      scheduled: counts.SCHEDULED ?? 0,
      archived: counts.ARCHIVED ?? 0,
      nextTopic: next ? rowToTopic(next as Parameters<typeof rowToTopic>[0]) : null,
    };
  });

  app.post('/api/topics', async (request, reply) => {
    const parsed = createTopicSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: validationMessage(parsed.error) });
    const now = new Date().toISOString();
    const { nextPosition } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS nextPosition FROM topics').get() as { nextPosition: number };
    const result = db.prepare(`
      INSERT INTO topics (position, title, summary, proposer, tags, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `).run(nextPosition, parsed.data.title, parsed.data.summary, parsed.data.proposer, JSON.stringify(parsed.data.tags), now, now);
    const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(result.lastInsertRowid);
    return reply.code(201).send(rowToTopic(topic as Parameters<typeof rowToTopic>[0]));
  });

  app.patch('/api/topics/:id', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = editTopicSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!row) return reply.code(404).send({ message: '没有找到这个议题' });
    const current = rowToTopic(row);
    const fieldsByStatus = {
      OPEN: ['presenter', 'scheduledAt', 'duration', 'room', 'takeaway', 'materialUrl'],
      CLAIMED: ['scheduledAt', 'duration', 'room', 'takeaway', 'materialUrl'],
      SCHEDULED: ['takeaway', 'materialUrl'],
      ARCHIVED: [],
    } as const;
    if (fieldsByStatus[current.status].some((field) => field in body.data)) {
      return reply.code(409).send({ message: '当前状态不能修改这些字段，请按议题流程操作' });
    }
    const next = { ...current, ...body.data };
    db.prepare(`
      UPDATE topics SET title = ?, summary = ?, proposer = ?, presenter = ?, tags = ?,
        scheduled_at = ?, duration = ?, room = ?, takeaway = ?, material_url = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title,
      next.summary,
      next.proposer,
      next.presenter || null,
      JSON.stringify(next.tags),
      next.scheduledAt,
      next.duration,
      next.room || null,
      next.takeaway || null,
      next.materialUrl || null,
      new Date().toISOString(),
      params.data.id,
    );
    return rowToTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.delete('/api/topics/:id', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: '议题编号不正确' });
    const result = db.prepare('DELETE FROM topics WHERE id = ?').run(params.data.id);
    if (result.changes === 0) return reply.code(404).send({ message: '没有找到这个议题' });
    return reply.code(204).send();
  });

  app.post('/api/topics/reorder', async (request, reply) => {
    const body = reorderSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: validationMessage(body.error) });
    const existing = db.prepare('SELECT id FROM topics ORDER BY position ASC, id ASC').all() as { id: number }[];
    if (existing.length !== body.data.orderedIds.length || existing.some(({ id }) => !body.data.orderedIds.includes(id))) {
      return reply.code(400).send({ message: '排序列表需要包含全部议题' });
    }
    const update = db.prepare('UPDATE topics SET position = ?, updated_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    db.transaction(() => body.data.orderedIds.forEach((id, index) => update.run(index + 1, now, id)))();
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
    return rowToTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.post('/api/topics/:id/schedule', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = scheduleSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const result = db.prepare("UPDATE topics SET scheduled_at = ?, duration = ?, room = ?, status = 'SCHEDULED', updated_at = ? WHERE id = ? AND status = 'CLAIMED'")
      .run(body.data.scheduledAt, body.data.duration, body.data.room, new Date().toISOString(), params.data.id);
    if (result.changes === 0) {
      const exists = db.prepare('SELECT 1 FROM topics WHERE id = ?').get(params.data.id);
      return exists
        ? reply.code(409).send({ message: '议题需要先被认领，才能安排分享' })
        : reply.code(404).send({ message: '没有找到这个议题' });
    }
    return rowToTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
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
    return rowToTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
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
