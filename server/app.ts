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
    const parsed = z.object({ status: z.enum(['OPEN', 'CLAIMED', 'SCHEDULED', 'ARCHIVED']).optional() }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: '状态筛选不正确' });
    const rows = parsed.data.status
      ? db.prepare('SELECT * FROM topics WHERE status = ? ORDER BY COALESCE(scheduled_at, created_at) DESC').all(parsed.data.status)
      : db.prepare("SELECT * FROM topics ORDER BY CASE status WHEN 'SCHEDULED' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'CLAIMED' THEN 2 ELSE 3 END, COALESCE(scheduled_at, created_at) DESC").all();
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
    const result = db.prepare(`
      INSERT INTO topics (title, summary, proposer, tags, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'OPEN', ?, ?)
    `).run(parsed.data.title, parsed.data.summary, parsed.data.proposer, JSON.stringify(parsed.data.tags), now, now);
    const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(result.lastInsertRowid);
    return reply.code(201).send(rowToTopic(topic as Parameters<typeof rowToTopic>[0]));
  });

  app.post('/api/topics/:id/claim', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = claimSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!topic) return reply.code(404).send({ message: '没有找到这个议题' });
    if (topic.status !== 'OPEN') return reply.code(409).send({ message: '这个议题已经被认领或排期' });
    db.prepare("UPDATE topics SET presenter = ?, status = 'CLAIMED', updated_at = ? WHERE id = ?")
      .run(body.data.presenter, new Date().toISOString(), params.data.id);
    return rowToTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.post('/api/topics/:id/schedule', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = scheduleSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!topic) return reply.code(404).send({ message: '没有找到这个议题' });
    if (topic.status !== 'CLAIMED') return reply.code(409).send({ message: '议题需要先被认领，才能安排分享' });
    db.prepare("UPDATE topics SET scheduled_at = ?, duration = ?, room = ?, status = 'SCHEDULED', updated_at = ? WHERE id = ?")
      .run(body.data.scheduledAt, body.data.duration, body.data.room, new Date().toISOString(), params.data.id);
    return rowToTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0]);
  });

  app.post('/api/topics/:id/archive', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = archiveSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: body.success ? '议题编号不正确' : validationMessage(body.error) });
    const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(params.data.id) as Parameters<typeof rowToTopic>[0] | undefined;
    if (!topic) return reply.code(404).send({ message: '没有找到这个议题' });
    if (topic.status !== 'SCHEDULED') return reply.code(409).send({ message: '只有已排期的议题可以归档' });
    const now = new Date().toISOString();
    db.prepare("UPDATE topics SET takeaway = ?, material_url = ?, status = 'ARCHIVED', archived_at = ?, updated_at = ? WHERE id = ?")
      .run(body.data.takeaway, body.data.materialUrl || null, now, now, params.data.id);
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
