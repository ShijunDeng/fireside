import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPosterModel, fitPosterTitle, isPosterEligible, posterFilename, posterLocation, sanitizePosterText, wrapPosterText } from '../src/poster';
import type { Topic } from '../src/types';

function topic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 1,
    position: 1,
    title: '把好奇举成一支火炬',
    summary: '从真实的问题出发，分享一次仍在生长的探索。',
    proposer: '发起人',
    presenter: '分享人',
    tags: ['AI', '产品'],
    status: 'SCHEDULED',
    scheduledAt: '2026-09-01T16:30:00.000Z',
    duration: 40,
    room: '三楼围炉会议室',
    meetingUrl: null,
    hasMeetingUrl: false,
    participantCount: 0,
    takeaway: null,
    materialUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('宣讲海报模型', () => {
  it('只允许仍在未来的已排期议题生成', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    assert.equal(isPosterEligible(topic(), now), true);
    assert.equal(isPosterEligible(topic({ scheduledAt: '2026-08-31T23:59:59.000Z' }), now), false);
    assert.equal(isPosterEligible(topic({ status: 'ARCHIVED' }), now), false);
    assert.throws(() => buildPosterModel(topic({ scheduledAt: '2026-08-01T00:00:00.000Z' }), 'https://fireside.test', now), /排期已过/);
  });

  it('按北京时间生成日期、时间与文件名', () => {
    const model = buildPosterModel(topic(), 'https://fireside.test/', new Date('2026-09-01T00:00:00.000Z'));
    assert.equal(model.dateKey, '20260902');
    assert.match(model.date, /2026年9月2日.*星期三/);
    assert.equal(model.time, '00:30 北京时间');
    assert.equal(model.source, 'fireside.test');
    assert.match(model.filename, /^围炉夜话-20260902-/);
  });

  it('所有可绘制用户字段都会移除链接与明显会议凭证', () => {
    const unsafe = topic({
      title: '今晚看 https://secret.test/a?pwd=alpha',
      summary: '会议号：998877，密码 beta，资料 www.secret.test/doc',
      presenter: '主持人 passcode: gamma',
      tags: ['Zoom', 'https://secret.test/tag'],
      room: '腾讯会议 会议号 123456 密码 delta',
      meetingUrl: 'https://secret.test/join?passcode=omega',
    });
    const model = buildPosterModel(unsafe, 'https://fireside.test', new Date('2026-09-01T00:00:00.000Z'));
    const rendered = JSON.stringify(model);
    for (const secret of ['secret.test', '998877', 'beta', 'gamma', '123456', 'delta', 'omega']) assert.equal(rendered.includes(secret), false);
    assert.equal(model.location, '线上参与 · 会议链接请在议题广场获取');
    assert.match(sanitizePosterText('密码: abc123'), /凭证已隐藏/);
  });

  it('混合活动同时保留线下地点与安全线上提示', () => {
    assert.equal(posterLocation(topic({ room: '三楼围炉会议室', meetingUrl: 'https://secret.test/join' })), '三楼围炉会议室 · 线上参与 · 会议链接请在议题广场获取');
    assert.equal(posterLocation(topic({ room: 'https://secret.test/join', meetingUrl: null })), '线上参与 · 会议链接请在议题广场获取');
  });

  it('极端长标题和简介都在边界内安全省略', () => {
    const longWord = `AI${'SuperLongWord'.repeat(30)}中英混排`;
    const measure = (value: string) => Array.from(value).length * 20;
    const summaryLines = wrapPosterText(longWord, measure, 220, 3);
    assert.ok(summaryLines.length <= 3);
    assert.ok(summaryLines.every((line) => measure(line) <= 220));
    assert.ok(summaryLines.at(-1)?.endsWith('…'));

    const layout = fitPosterTitle('火'.repeat(80), (size, value) => Array.from(value).length * size);
    assert.ok(layout.size >= 48 && layout.size <= 76);
    assert.ok(layout.lines.length <= 5);
    assert.ok(layout.lines.every((line) => Array.from(line.replace(/…$/, '')).length * layout.size <= 880));
  });

  it('下载文件名移除系统非法字符并限制长度', () => {
    const filename = posterFilename('20260902', 'A/B:C*D?E"F<G>H|I\u0001'.repeat(10));
    assert.doesNotMatch(filename, /[\\/:*?"<>|\u0000-\u001f]/);
    assert.ok(Array.from(filename.replace(/^围炉夜话-20260902-/, '').replace(/\.png$/, '')).length <= 36);
  });
});
