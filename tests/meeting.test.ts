import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeMeetingRoom, extractMeetingUrl } from '../server/meeting.js';
import {
  containsMeetingSensitiveText,
  findMeetingSensitiveSpans,
  redactMeetingSensitiveText,
} from '../shared/meeting-text.js';

describe('会议地点隐私分析', () => {
  it('识别并提取混合文本中的可点击会议入口', () => {
    const cases = [
      ['https://meet.example.test/join?passcode=omega', 'https://meet.example.test/join?passcode=omega'],
      ['线上入口：https://meet.example.test/join?pwd=omega，周三见', 'https://meet.example.test/join?pwd=omega'],
      ['请访问 www.example.test/join?pwd=omega 后入会', 'https://www.example.test/join?pwd=omega'],
    ] as const;
    for (const [room, expected] of cases) {
      const analysis = analyzeMeetingRoom(room);
      assert.equal(analysis.sensitive, true);
      assert.equal(analysis.meetingUrl, expected);
      assert.equal(analysis.publicRoom, '线上会议');
      assert.equal(extractMeetingUrl(room), expected);
    }
  });

  it('识别会议号、中文密码和英文凭证但不制造不可点击入口', () => {
    for (const room of [
      '腾讯会议 123 456 789，密码：秘密口令',
      'Teams 会议号=998877 passcode = a-b_C',
      '会议码 556677，口令：火炬',
      '线上参与 pwd=hidden-token',
      'Meeting ID: 123-456-789',
      'meeting number\n123 456 789',
      '入会码：火炬',
      '入会密码\n星火口令',
      'PASSWORD = mixed_秘密-2026',
      'PIN#778899',
      '口令＝围炉',
    ]) {
      const analysis = analyzeMeetingRoom(room);
      assert.equal(analysis.sensitive, true, room);
      assert.equal(analysis.meetingUrl, null, room);
      assert.equal(analysis.publicRoom, '线上参与信息已隐藏', room);
    }
  });

  it('保留普通地点并避免常见误判', () => {
    for (const room of [
      '三楼围炉会议室',
      '腾讯会议室 A',
      '飞书会议室',
      '密码学读书会',
      '密码学基础',
      '现代密码学与零知识证明',
      '密码管理实践',
      '口令设计原则',
      '3号会议室',
      'Zoom 产品设计',
      'Teams 协作复盘',
      '飞书会议体验',
      '会议号码为什么总是很长？',
      '会议号码牌设计',
      '入会码率优化',
      '版本号 123456',
      '订单号 123 456 789',
      '2026 年 9 月 18 日',
      '分享时长 40 分钟',
      '密码学（基础）',
      '3号会议室（东区）',
      '腾讯会议室【A区】',
      'Zoom（产品设计）',
      'Teams〔协作复盘〕',
      '飞书会议〔体验复盘〕',
      '会议号码牌（设计）',
      '口令设计原则【草案】',
    ]) {
      assert.deepEqual(analyzeMeetingRoom(room), { sensitive: false, meetingUrl: null, publicRoom: room });
      assert.equal(containsMeetingSensitiveText(room), false, room);
      assert.equal(redactMeetingSensitiveText(room), room);
    }
  });

  it('把标签和值之间的成对括号作为明确边界并消费完整闭合值', () => {
    for (const input of [
      '入会码（火炬）',
      '会议号(123 456 789)',
      '会议号码：[321-654-987]',
      'PWD【omega】',
      'passcode〔a-b_C〕',
      '腾讯会议 [987 654 321]',
    ]) {
      assert.equal(containsMeetingSensitiveText(input), true, input);
      assert.equal(redactMeetingSensitiveText(input), '[凭证已隐藏]', input);
      assert.equal(redactMeetingSensitiveText(redactMeetingSensitiveText(input)), '[凭证已隐藏]', input);
    }
  });

  it('完整隐藏 Unicode、分段和多凭证值，不留下可重建残段', () => {
    const cases = [
      { input: '会议 号：123 456 789', forbidden: ['会议 号', '123', '456', '789'] },
      { input: '会议号码 123-456-789', forbidden: ['123', '456', '789'] },
      { input: '会议码：\n556 677 889', forbidden: ['556', '677', '889'] },
      { input: '入会码：火炬', forbidden: ['入会码', '火炬'] },
      { input: '腾讯会议 123 456 789', forbidden: ['腾讯会议', '123', '456', '789'] },
      { input: 'Zoom 123-456-789', forbidden: ['Zoom', '123', '456', '789'] },
      { input: '会议密码：星火口令', forbidden: ['会议密码', '星火口令'] },
      { input: '密码 秘密口令', forbidden: ['密码', '秘密口令'] },
      { input: '口令=围炉-2026', forbidden: ['口令', '围炉', '2026'] },
      { input: 'passcode = a b-C_9', forbidden: ['passcode', 'a b-C_9'] },
      { input: 'PWD=omega', forbidden: ['PWD', 'omega'] },
      { input: 'Meeting Code: alpha-2026', forbidden: ['Meeting Code', 'alpha-2026'] },
      { input: '会议号 123 456 789，密码：星火口令', forbidden: ['123', '456', '789', '星火口令'] },
    ] as const;

    for (const { input, forbidden } of cases) {
      const redacted = redactMeetingSensitiveText(input);
      assert.equal(containsMeetingSensitiveText(input), true, input);
      assert.match(redacted, /\[凭证已隐藏\]/u, input);
      for (const fragment of forbidden) assert.equal(redacted.includes(fragment), false, `${input} leaked ${fragment}: ${redacted}`);
      assert.equal(redactMeetingSensitiveText(redacted), redacted, `not idempotent: ${input}`);
    }
  });

  it('先完整隐藏 URL，保留其后的普通说明且脱敏保持幂等', () => {
    const input = '入口：https://meet.example.test/join?pwd=omega，周三见；备用 www.example.test/a?passcode=beta。';
    const redacted = redactMeetingSensitiveText(input);
    assert.equal(redacted, '入口：[链接已隐藏]，周三见；备用 [链接已隐藏]。');
    assert.equal(redactMeetingSensitiveText(redacted), redacted);
    assert.deepEqual(findMeetingSensitiveSpans(input).map(({ kind }) => kind), ['url', 'url']);
  });

  it('完整保留 URL 内成对括号并在不配对的外层闭括号前终止', () => {
    const cases = [
      'https://meet.example.test/join/(room-42)?token=TOPSECRET',
      'https://secret.example.test/join/(team)/room?pwd=parenUrlSecret',
      'https://meet.example.test/join[room]?token=TOPSECRET',
      'https://meet.example.test/join/{room}?token=TOPSECRET',
    ];
    for (const url of cases) {
      const input = `入口：${url}`;
      assert.equal(redactMeetingSensitiveText(input), '入口：[链接已隐藏]', input);
      assert.equal(extractMeetingUrl(input), new URL(url).toString(), input);
    }

    const wrapped = '入口（https://meet.example.test/join/(room-42)?token=TOPSECRET）之后照常讨论';
    assert.equal(redactMeetingSensitiveText(wrapped), '入口（[链接已隐藏]）之后照常讨论');
    assert.equal(
      extractMeetingUrl(wrapped),
      'https://meet.example.test/join/(room-42)?token=TOPSECRET',
    );
    for (const fragment of ['room-42', 'TOPSECRET']) {
      assert.equal(redactMeetingSensitiveText(wrapped).includes(fragment), false);
    }
  });

  it('凭证在明确标点处终止并保留后续普通说明', () => {
    assert.equal(
      redactMeetingSensitiveText('参与信息：密码：秘密口令，周三晚上见；请提前五分钟到场'),
      '参与信息：[凭证已隐藏]，周三晚上见；请提前五分钟到场',
    );
    assert.equal(
      redactMeetingSensitiveText('会议号：123 456 789；地点仍是三楼围炉会议室'),
      '[凭证已隐藏]；地点仍是三楼围炉会议室',
    );
    assert.equal(
      redactMeetingSensitiveText('会议号：123 456 789 地点仍是三楼围炉会议室'),
      '[凭证已隐藏] 地点仍是三楼围炉会议室',
    );
    assert.equal(
      redactMeetingSensitiveText('会议号：123 456 789\n下一行是普通活动说明'),
      '[凭证已隐藏]\n下一行是普通活动说明',
    );
    assert.equal(
      redactMeetingSensitiveText('会议码：556 677 889\n下一行是普通活动说明'),
      '[凭证已隐藏]\n下一行是普通活动说明',
    );
    assert.equal(
      redactMeetingSensitiveText('Meeting Code: 246-810-121\nordinary follow-up'),
      '[凭证已隐藏]\nordinary follow-up',
    );
    assert.equal(
      redactMeetingSensitiveText('腾讯会议 123 456 789\n下一行是普通活动说明'),
      '[凭证已隐藏]\n下一行是普通活动说明',
    );
    assert.equal(
      redactMeetingSensitiveText('会议号：123abc'),
      '[凭证已隐藏]',
      '紧邻数字的字母仍属于同一凭证，不能当作普通说明泄漏',
    );
  });
});
