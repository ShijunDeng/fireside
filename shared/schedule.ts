export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
export const BUSINESS_TIME_SUFFIX = '北京时间';

const MINUTE_MS = 60_000;

interface BusinessDateParts {
  year: number;
  month: number;
  day: number;
}

export interface ScheduledTopicLike {
  id: number;
  scheduledAt: string | null | undefined;
}

export interface ScheduleIntervalLike extends ScheduledTopicLike {
  duration: number | null | undefined;
}

export interface ScheduleBounds {
  startEpoch: number;
  endEpoch: number;
}

const businessDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const businessTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function asDate(value: Date | string | number) {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new RangeError('无效的日期时间');
  return result;
}

function businessDateParts(value: Date | string | number): BusinessDateParts {
  const parts = Object.fromEntries(
    businessDateFormatter.formatToParts(asDate(value)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

/** Return the Asia/Shanghai natural date containing the supplied instant. */
export function businessDateKey(value: Date | string | number) {
  const { year, month, day } = businessDateParts(value);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Return a timezone-neutral calendar cursor for today's Asia/Shanghai date.
 *
 * Noon UTC keeps the represented civil date stable in the browser timezones we
 * support. Consumers should use the calendar helpers/businessDateKey rather
 * than treating this cursor as the actual start-of-day instant.
 */
export function businessTodayCursor(now = new Date()) {
  const { year, month, day } = businessDateParts(now);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

export function formatBusinessTime(value: Date | string | number) {
  const parts = Object.fromEntries(
    businessTimeFormatter.formatToParts(asDate(value)).map((part) => [part.type, part.value]),
  );
  return `${parts.hour}:${parts.minute} ${BUSINESS_TIME_SUFFIX}`;
}

/** Format an instant as the wall-clock value expected by datetime-local. */
export function formatBusinessDateTimeInput(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '';
  const date = asDate(value);
  return `${businessDateKey(date)}T${formatBusinessTime(date).slice(0, 5)}`;
}

/** Convert a Beijing wall-clock datetime-local value to a canonical UTC ISO instant. */
export function businessDateTimeInputToUtc(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError('无效的北京时间输入');

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const calendarCheck = new Date(0);
  calendarCheck.setUTCFullYear(year, month - 1, day);
  calendarCheck.setUTCHours(hour, minute, 0, 0);
  if (
    month < 1 || month > 12
    || day < 1 || day > 31
    || hour < 0 || hour > 23
    || minute < 0 || minute > 59
    || calendarCheck.getUTCFullYear() !== year
    || calendarCheck.getUTCMonth() !== month - 1
    || calendarCheck.getUTCDate() !== day
  ) {
    throw new RangeError('无效的北京时间输入');
  }

  return new Date(calendarCheck.getTime() - 8 * 60 * MINUTE_MS).toISOString();
}

function scheduleEpoch(topic: ScheduledTopicLike) {
  if (!topic.scheduledAt) return Number.POSITIVE_INFINITY;
  const epoch = new Date(topic.scheduledAt).getTime();
  return Number.isFinite(epoch) ? epoch : Number.POSITIVE_INFINITY;
}

/** Compare Topics by absolute start epoch, then numeric Topic ID. */
export function compareTopicsBySchedule(a: ScheduledTopicLike, b: ScheduledTopicLike) {
  const epochDifference = scheduleEpoch(a) - scheduleEpoch(b);
  if (Number.isFinite(epochDifference) && epochDifference !== 0) return epochDifference;
  if (scheduleEpoch(a) !== scheduleEpoch(b)) {
    return scheduleEpoch(a) < scheduleEpoch(b) ? -1 : 1;
  }
  return a.id - b.id;
}

export function sortTopicsBySchedule<T extends ScheduledTopicLike>(topics: readonly T[]) {
  return [...topics].sort(compareTopicsBySchedule);
}

export function scheduleBounds(interval: ScheduleIntervalLike): ScheduleBounds | null {
  const startEpoch = scheduleEpoch(interval);
  if (!Number.isFinite(startEpoch) || !Number.isFinite(interval.duration) || !interval.duration || interval.duration <= 0) {
    return null;
  }
  const endEpoch = startEpoch + interval.duration * MINUTE_MS;
  if (!Number.isFinite(endEpoch)) return null;
  return { startEpoch, endEpoch };
}

/** Half-open interval comparison: adjacent [start, end) sessions do not overlap. */
export function scheduleIntervalsOverlap(a: ScheduleIntervalLike, b: ScheduleIntervalLike) {
  const aBounds = scheduleBounds(a);
  const bBounds = scheduleBounds(b);
  if (!aBounds || !bBounds) return false;
  return aBounds.startEpoch < bBounds.endEpoch && bBounds.startEpoch < aBounds.endEpoch;
}

/** Find other conflicting Topics, returned in canonical epoch/ID order. */
export function findScheduleConflicts<T extends ScheduleIntervalLike>(
  candidate: ScheduleIntervalLike,
  existing: readonly T[],
) {
  return sortTopicsBySchedule(existing.filter(
    (topic) => topic.id !== candidate.id && scheduleIntervalsOverlap(candidate, topic),
  ));
}
