import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMonthDays, buildWeekDays, dateKey, startOfWeek } from '../src/calendar.js';

describe('日历日期计算', () => {
  it('自然周始终从周一开始', () => {
    const monday = startOfWeek(new Date(2026, 8, 6, 12));
    assert.equal(dateKey(monday), '2026-08-31');
    assert.equal(monday.getDay(), 1);
  });

  it('月历固定生成包含跨月日期的 42 天', () => {
    const days = buildMonthDays(new Date(2026, 8, 15, 12));
    assert.equal(days.length, 42);
    assert.equal(dateKey(days[0]), '2026-08-31');
    assert.equal(dateKey(days[41]), '2026-10-11');
  });

  it('周历正确跨越年份边界', () => {
    const days = buildWeekDays(new Date(2027, 0, 1, 12));
    assert.deepEqual(days.map(dateKey), [
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
      '2027-01-01', '2027-01-02', '2027-01-03',
    ]);
  });
});
