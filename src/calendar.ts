import {
  businessDateKey,
  businessDateTimeInputToUtc,
  businessTodayCursor,
  compareTopicsBySchedule,
  findScheduleConflicts,
  formatBusinessDateTimeInput,
  formatBusinessTime,
  scheduleBounds,
  scheduleIntervalsOverlap,
  sortTopicsBySchedule,
} from '../shared/schedule';

export {
  BUSINESS_TIME_SUFFIX,
  BUSINESS_TIME_ZONE,
  businessDateKey,
  businessDateTimeInputToUtc,
  businessTodayCursor,
  compareTopicsBySchedule,
  findScheduleConflicts,
  formatBusinessDateTimeInput,
  formatBusinessTime,
  scheduleBounds,
  scheduleIntervalsOverlap,
  sortTopicsBySchedule,
} from '../shared/schedule';

export function dateKey(date: Date) {
  return businessDateKey(date);
}

export function startOfWeek(date: Date) {
  const [year, month, dayOfMonth] = businessDateKey(date).split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, dayOfMonth, 12));
  const day = result.getUTCDay() || 7;
  result.setUTCDate(result.getUTCDate() - day + 1);
  return result;
}

export function buildMonthDays(cursor: Date) {
  const [year, month] = businessDateKey(cursor).split('-').map(Number);
  const monthStart = new Date(Date.UTC(year, month - 1, 1, 12));
  const gridStart = startOfWeek(monthStart);
  return Array.from({ length: 42 }, (_, index) => {
    const result = new Date(gridStart);
    result.setUTCDate(result.getUTCDate() + index);
    return result;
  });
}

export function buildWeekDays(cursor: Date) {
  const weekStart = startOfWeek(cursor);
  return Array.from({ length: 7 }, (_, index) => {
    const result = new Date(weekStart);
    result.setUTCDate(result.getUTCDate() + index);
    return result;
  });
}

export function formatDateTimeInput(value: string | null) {
  return formatBusinessDateTimeInput(value);
}

export const dateTimeInputToUtc = businessDateTimeInputToUtc;
