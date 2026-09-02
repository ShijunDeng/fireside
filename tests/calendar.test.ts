import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMonthDays,
  buildWeekDays,
  businessDateKey,
  businessTodayCursor,
  dateKey,
  dateTimeInputToUtc,
  findScheduleConflicts,
  formatBusinessTime,
  formatDateTimeInput,
  scheduleIntervalsOverlap,
  sortTopicsBySchedule,
  startOfWeek,
} from '../src/calendar.js';

describe('日历日期计算', () => {
  it('自然周始终从周一开始', () => {
    const monday = startOfWeek(new Date('2026-09-06T03:00:00.000Z'));
    assert.equal(dateKey(monday), '2026-08-31');
    assert.equal(monday.getUTCDay(), 1);
  });

  it('月历固定生成包含跨月日期的 42 天', () => {
    const days = buildMonthDays(new Date('2026-09-15T03:00:00.000Z'));
    assert.equal(days.length, 42);
    assert.equal(dateKey(days[0]), '2026-08-31');
    assert.equal(dateKey(days[41]), '2026-10-11');
  });

  it('周历正确跨越年份边界', () => {
    const days = buildWeekDays(new Date('2027-01-01T03:00:00.000Z'));
    assert.deepEqual(days.map(dateKey), [
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
      '2027-01-01', '2027-01-02', '2027-01-03',
    ]);
  });

  it('业务日、今日游标和时间标签固定使用北京时间', () => {
    const instant = new Date('2026-09-01T16:30:00.000Z');
    assert.equal(businessDateKey(instant), '2026-09-02');
    assert.equal(dateKey(businessTodayCursor(instant)), '2026-09-02');
    assert.equal(formatBusinessTime(instant), '00:30 北京时间');
  });

  it('datetime-local 在北京墙上时间和 UTC 之间稳定往返', () => {
    const instant = '2026-09-01T16:30:00.000Z';
    assert.equal(formatDateTimeInput(instant), '2026-09-02T00:30');
    assert.equal(dateTimeInputToUtc('2026-09-02T00:30'), instant);
    assert.equal(formatDateTimeInput(null), '');
    assert.throws(() => dateTimeInputToUtc('2026-02-29T18:00'), /无效的北京时间输入/);
  });
});

describe('同日多场排期纯逻辑', () => {
  const topic = (id: number, scheduledAt: string, duration = 60) => ({ id, scheduledAt, duration });

  it('按开始 epoch 排序，同一时刻再按 Topic ID 稳定排序', () => {
    const sorted = sortTopicsBySchedule([
      topic(8, '2026-09-02T12:00:00+08:00'),
      topic(7, '2026-09-02T04:00:00.000Z'),
      topic(3, '2026-09-02T03:00:00.000Z'),
    ]);
    assert.deepEqual(sorted.map(({ id }) => id), [3, 7, 8]);
  });

  it('半开区间允许首尾相接，但拒绝 1ms 、同起点和时长扩张重叠', () => {
    const base = topic(1, '2026-09-02T10:00:00+08:00', 60);
    assert.equal(scheduleIntervalsOverlap(base, topic(2, '2026-09-02T11:00:00+08:00', 30)), false);
    assert.equal(scheduleIntervalsOverlap(base, topic(2, '2026-09-02T02:59:59.999Z', 30)), true);
    assert.equal(scheduleIntervalsOverlap(base, topic(2, '2026-09-02T10:00:00+08:00', 1)), true);
    assert.equal(scheduleIntervalsOverlap(base, topic(2, '2026-09-02T09:30:00+08:00', 31)), true);
  });

  it('不同 offset 按同一绝对时段判定，并按 epoch/ID 返回冲突', () => {
    const candidate = topic(10, '2026-09-02T10:00:00+08:00', 60);
    const conflicts = findScheduleConflicts(candidate, [
      topic(13, '2026-09-02T02:30:00.000Z', 15),
      topic(12, '2026-09-01T22:30:00-04:00', 15),
      topic(11, '2026-09-02T03:00:00.000Z', 30),
      candidate,
    ]);
    assert.deepEqual(conflicts.map(({ id }) => id), [12, 13]);
  });

  it('跨午夜活动归入开始日，仍会和次日时段正确冲突', () => {
    const overnight = topic(1, '2026-09-02T23:30:00+08:00', 90);
    assert.equal(businessDateKey(overnight.scheduledAt), '2026-09-02');
    assert.equal(scheduleIntervalsOverlap(overnight, topic(2, '2026-09-03T00:30:00+08:00', 30)), true);
  });
});
