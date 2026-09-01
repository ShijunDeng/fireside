import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Topic, TopicStatus } from './types.js';

type TopicRow = {
  id: number;
  position: number;
  title: string;
  summary: string;
  proposer: string;
  presenter: string | null;
  tags: string;
  status: TopicStatus;
  scheduled_at: string | null;
  duration: number | null;
  room: string | null;
  takeaway: string | null;
  material_url: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export function rowToTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    position: row.position,
    title: row.title,
    summary: row.summary,
    proposer: row.proposer,
    presenter: row.presenter,
    tags: JSON.parse(row.tags) as string[],
    status: row.status,
    scheduledAt: row.scheduled_at,
    duration: row.duration,
    room: row.room,
    takeaway: row.takeaway,
    materialUrl: row.material_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function seedDatabase(db: Database.Database) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM topics').get() as { count: number };
  if (count.count > 0) return;

  const now = new Date();
  const inTwoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  inTwoDays.setHours(19, 30, 0, 0);
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const createdAt = now.toISOString();
  const insert = db.prepare(`
    INSERT INTO topics
      (position, title, summary, proposer, presenter, tags, status, scheduled_at, duration, room, takeaway, material_url, created_at, updated_at, archived_at)
    VALUES
      (@position, @title, @summary, @proposer, @presenter, @tags, @status, @scheduledAt, @duration, @room, @takeaway, @materialUrl, @createdAt, @updatedAt, @archivedAt)
  `);

  const samples = [
    {
      title: 'AI Agent 的记忆，究竟该记住什么？',
      summary: '从短期上下文、长期记忆到可遗忘机制，一起拆解 Agent 记忆设计的真实取舍。',
      proposer: '小川', presenter: null, tags: ['AI Agent', '架构'], status: 'OPEN',
      scheduledAt: null, duration: null, room: null, takeaway: null, materialUrl: null,
      createdAt, updatedAt: createdAt, archivedAt: null,
    },
    {
      title: '把一个模糊想法做成可用 Demo',
      summary: '现场走一遍从需求澄清、原型到 AI 辅助编码的完整路径，看看一天能走多远。',
      proposer: '林檎', presenter: '阿杰', tags: ['Demo', '产品'], status: 'SCHEDULED',
      scheduledAt: inTwoDays.toISOString(), duration: 40, room: '围炉会议室', takeaway: null, materialUrl: null,
      createdAt, updatedAt: createdAt, archivedAt: null,
    },
    {
      title: 'RAG 不是万能药：我们踩过的三个坑',
      summary: '聊聊知识切分、召回评估和“看起来很聪明”的幻觉，附真实项目复盘。',
      proposer: 'Mia', presenter: 'Mia', tags: ['RAG', '复盘'], status: 'ARCHIVED',
      scheduledAt: lastWeek.toISOString(), duration: 35, room: '线上',
      takeaway: '先定义评估集，再谈召回优化；检索质量和生成质量必须分开度量。',
      materialUrl: null, createdAt, updatedAt: createdAt, archivedAt: lastWeek.toISOString(),
    },
    {
      title: '为什么好的工具都在悄悄降低认知负担？',
      summary: '从 Linear、Raycast 到 Notion Calendar，观察优秀工具如何让复杂工作变得安静。',
      proposer: '北辰', presenter: '北辰', tags: ['产品设计', '效率'], status: 'CLAIMED',
      scheduledAt: null, duration: null, room: null, takeaway: null, materialUrl: null,
      createdAt, updatedAt: createdAt, archivedAt: null,
    },
  ] as const;

  const transaction = db.transaction(() => {
    for (const [index, sample] of samples.entries()) {
      insert.run({ ...sample, position: index + 1, tags: JSON.stringify(sample.tags) });
    }
  });
  transaction();
}

export function createDatabase(databasePath: string, seed = true) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      proposer TEXT NOT NULL,
      presenter TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLAIMED','SCHEDULED','ARCHIVED')),
      scheduled_at TEXT,
      duration INTEGER,
      room TEXT,
      takeaway TEXT,
      material_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status);
    CREATE INDEX IF NOT EXISTS idx_topics_scheduled_at ON topics(scheduled_at);
    CREATE TABLE IF NOT EXISTS topic_order_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0)
    );
    INSERT OR IGNORE INTO topic_order_state (id, version) VALUES (1, 0);
  `);
  const columns = db.prepare('PRAGMA table_info(topics)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'position')) {
    db.exec('ALTER TABLE topics ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('UPDATE topics SET position = id WHERE position = 0');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_position ON topics(position)');
  if (seed) seedDatabase(db);
  return db;
}
