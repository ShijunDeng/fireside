import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPosterLayout,
  buildPosterModel,
  fitPosterTitle,
  isPosterEligible,
  posterFilename,
  posterLocation,
  sanitizePosterText,
  wrapPosterText,
} from '../src/poster';
import type { Topic } from '../src/types';

function topic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 1,
    position: 1,
    revision: 1,
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

  it('完整隐藏 Unicode、英文与分段会议凭证且不留下残片', () => {
    const cases = [
      { input: '入会码：火炬', secrets: ['火炬'] },
      { input: '密码：秘密口令', secrets: ['秘密口令'] },
      { input: '口令：围炉', secrets: ['围炉'] },
      { input: 'pwd=omega', secrets: ['omega'] },
      { input: '会议号：123 456 789', secrets: ['123', '456', '789'] },
      { input: '会议 号：321-654-987', secrets: ['321', '654', '987'] },
      { input: 'Meeting ID: 246-810-121', secrets: ['246', '810', '121'] },
      { input: 'PASSWORD = a-b_C', secrets: ['a-b_C'] },
      { input: 'PIN # 4321', secrets: ['4321'] },
      { input: '腾讯会议\n135 790 246', secrets: ['135', '790', '246'] },
      { input: 'passcode：中文密语', secrets: ['中文密语'] },
      { input: '入口 www.secret.test/join?pwd=never-visible', secrets: ['secret.test', 'never-visible'] },
    ];
    for (const { input, secrets } of cases) {
      const redacted = sanitizePosterText(input);
      for (const secret of secrets) assert.equal(redacted.includes(secret), false, `${input} 残留 ${secret}`);
      assert.match(redacted, /\[(?:链接|凭证)已隐藏\]/, input);
    }
  });

  it('保留会议文本的 false-positive 边界', () => {
    const safeValues = [
      '密码学读书会',
      '密码学基础',
      '3号会议室',
      '腾讯会议室 A',
      'Zoom 产品设计',
      'Teams 协作复盘',
      '飞书会议体验',
      '会议号码为什么总是很长？',
      '口令设计原则',
      '密码管理实践',
    ];
    for (const value of safeValues) assert.equal(sanitizePosterText(value), value);
  });

  it('逐字段和文件名独立防止会议凭证泄漏', () => {
    const unsafe = topic({
      title: '标题 入会码：标题火炬',
      summary: '简介 pwd=summaryOmega',
      presenter: '分享人 口令：分享密语',
      tags: ['会议号：111 222 333', 'PIN=tagPin', '普通标签'],
      room: '腾讯会议 444 555 666',
      meetingUrl: 'https://meet.secret.test/join?passcode=urlSecret',
    });
    const model = buildPosterModel(unsafe, 'https://fireside.test', new Date('2026-09-01T00:00:00.000Z'));
    const rendered = JSON.stringify(model);
    for (const secret of [
      '标题火炬', 'summaryOmega', '分享密语', '111', '222', '333', 'tagPin', '444', '555', '666', 'secret.test', 'urlSecret',
    ]) assert.equal(rendered.includes(secret), false, secret);

    const filename = posterFilename('20260902', '会议号：777 888 999 pwd=filenameSecret');
    for (const secret of ['777', '888', '999', 'filenameSecret']) assert.equal(filename.includes(secret), false, secret);
  });

  it('括号式凭证与 URL 路径不进入海报字段或文件名', () => {
    const unsafe = topic({
      title: '标题 入会密码（火炬）',
      summary: '简介 会议号(123 456 789)',
      presenter: '分享人 PWD【omega】',
      tags: ['passcode〔a-b_C〕', '入口 https://meet.example/join/(room-42)/stage?pwd=TOPSECRET'],
      room: '腾讯会议 [987 654 321]',
      meetingUrl: null,
      hasMeetingUrl: false,
    });
    const model = buildPosterModel(unsafe, 'https://fireside.test', new Date('2026-09-01T00:00:00.000Z'));
    const rendered = JSON.stringify(model);
    for (const secret of [
      '火炬', '123', '456', '789', 'omega', 'a-b_C', 'meet.example', 'room-42', 'TOPSECRET', '987', '654', '321',
    ]) assert.equal(rendered.includes(secret), false, secret);

    const filename = posterFilename(
      '20260902',
      '宣讲 入会码（文件火炬） https://meet.example/join/(filename-room)?pwd=filenameSecret',
    );
    for (const secret of ['文件火炬', 'meet.example', 'filename-room', 'filenameSecret']) {
      assert.equal(filename.includes(secret), false, secret);
    }
  });

  it('混合活动同时保留线下地点与安全线上提示', () => {
    assert.equal(posterLocation(topic({ room: '三楼围炉会议室', meetingUrl: 'https://secret.test/join' })), '三楼围炉会议室 · 线上参与 · 会议链接请在议题广场获取');
    assert.equal(posterLocation(topic({ room: 'https://secret.test/join', meetingUrl: null })), '线上参与 · 会议链接请在议题广场获取');
    assert.equal(posterLocation(topic({ room: '入会码：历史火炬', meetingUrl: null, hasMeetingUrl: false })), '线上参与 · 会议链接请在议题广场获取');
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

  it('合法标题 1..80 字都为最大其他内容保留完整纵向预算', () => {
    const measure = (fontSize: number, value: string) => Array.from(value).length * fontSize;
    const bottom = ({ y, height }: { y: number; height: number }) => y + height;
    const observedRegressionSizes = new Map<number, number>();

    for (let titleLength = 1; titleLength <= 80; titleLength += 1) {
      const model = buildPosterModel(topic({
        title: '火'.repeat(titleLength),
        summary: '探索'.repeat(250),
        presenter: '讲'.repeat(30),
        tags: Array.from({ length: 5 }, (_, index) => `${index + 1}${'标'.repeat(19)}`),
      }), 'https://fireside.test', new Date('2026-09-01T00:00:00.000Z'));
      const layout = buildPosterLayout(model, measure);
      const failureContext = `titleLength=${titleLength}, fontSize=${layout.title.fontSize}`;

      assert.ok(layout.title.lines.length <= 5, failureContext);
      assert.ok(layout.title.lines.every((line) => measure(layout.title.fontSize, line) <= layout.title.bounds.width), failureContext);
      assert.equal(layout.summary.lines.length, 3, failureContext);
      assert.ok(layout.summary.lines.every((line) => measure(layout.summary.fontSize, line) <= layout.summary.bounds.width), failureContext);
      assert.ok(bottom(layout.title.bounds) + 20 <= layout.summary.bounds.y, failureContext);
      assert.ok(bottom(layout.summary.bounds) + 20 <= layout.info.y, failureContext);
      assert.ok(bottom(layout.info) + 20 <= layout.tagRegion.y, failureContext);
      assert.ok(bottom(layout.tagRegion) + 20 <= layout.footer.y, failureContext);
      assert.ok(bottom(layout.footer) <= 1440, failureContext);
      assert.ok(measure(25, layout.presenterText) <= layout.presenterMaxWidth, failureContext);

      assert.equal(layout.tags.length, 5, failureContext);
      for (const [index, tag] of layout.tags.entries()) {
        assert.match(tag.text, new RegExp(`^${index + 1}`), failureContext);
        assert.ok(measure(20, tag.text) <= tag.textMaxWidth, failureContext);
        assert.ok(tag.bounds.x >= 96, failureContext);
        assert.ok(tag.bounds.x + tag.bounds.width <= 984, failureContext);
        if (index > 0) {
          assert.ok(layout.tags[index - 1].bounds.x + layout.tags[index - 1].bounds.width < tag.bounds.x, failureContext);
        }
      }

      if ([45, 55, 60].includes(titleLength)) observedRegressionSizes.set(titleLength, layout.title.fontSize);
    }

    assert.deepEqual(Object.fromEntries(observedRegressionSizes), { 45: 72, 55: 64, 60: 64 });
  });

  it('下载文件名移除系统非法字符并限制长度', () => {
    const filename = posterFilename('20260902', 'A/B:C*D?E"F<G>H|I\u0001'.repeat(10));
    assert.doesNotMatch(filename, /[\\/:*?"<>|\u0000-\u001f]/);
    assert.ok(Array.from(filename.replace(/^围炉夜话-20260902-/, '').replace(/\.png$/, '')).length <= 36);
  });
});
