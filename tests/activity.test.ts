import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activityPhase } from '../shared/activity.js';

describe('活动派生阶段', () => {
  const start = Date.parse('2026-09-02T12:00:00.000Z');
  const scheduledAt = new Date(start).toISOString();
  const duration = 40;
  const end = start + duration * 60_000;

  it('在开始与结束毫秒边界精确切换', () => {
    assert.equal(activityPhase(scheduledAt, duration, new Date(start - 1)), 'UPCOMING');
    assert.equal(activityPhase(scheduledAt, duration, new Date(start)), 'LIVE');
    assert.equal(activityPhase(scheduledAt, duration, new Date(end - 1)), 'LIVE');
    assert.equal(activityPhase(scheduledAt, duration, new Date(end)), 'ENDED');
  });

  it('使用绝对时间而不是本地时区字符串比较', () => {
    assert.equal(activityPhase('2026-09-02T20:00:00.000+08:00', duration, new Date(start)), 'LIVE');
  });

  it('对缺失或非法排期返回 null', () => {
    assert.equal(activityPhase(null, duration, new Date(start)), null);
    assert.equal(activityPhase('not-a-date', duration, new Date(start)), null);
    assert.equal(activityPhase(scheduledAt, null, new Date(start)), null);
    assert.equal(activityPhase(scheduledAt, 0, new Date(start)), null);
    assert.equal(activityPhase(scheduledAt, Number.NaN, new Date(start)), null);
    assert.equal(activityPhase(scheduledAt, duration, new Date(Number.NaN)), null);
  });
});
