import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeMeetingRoom, extractMeetingUrl } from '../server/meeting.js';

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
    ]) {
      const analysis = analyzeMeetingRoom(room);
      assert.equal(analysis.sensitive, true, room);
      assert.equal(analysis.meetingUrl, null, room);
      assert.equal(analysis.publicRoom, '线上参与信息已隐藏', room);
    }
  });

  it('保留普通地点并避免常见误判', () => {
    for (const room of ['三楼围炉会议室', '腾讯会议室 A', '密码学读书会', '3号会议室']) {
      assert.deepEqual(analyzeMeetingRoom(room), { sensitive: false, meetingUrl: null, publicRoom: room });
    }
  });
});
