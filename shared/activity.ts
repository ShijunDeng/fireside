export type ActivityPhase = 'UPCOMING' | 'LIVE' | 'ENDED';

export function activityPhase(
  scheduledAt: string | null | undefined,
  duration: number | null | undefined,
  now: Date,
): ActivityPhase | null {
  if (!scheduledAt || !Number.isFinite(duration) || !duration || duration <= 0) return null;
  const start = new Date(scheduledAt).getTime();
  const current = now.getTime();
  const end = start + duration * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(current) || !Number.isFinite(end)) return null;
  if (current < start) return 'UPCOMING';
  if (current < end) return 'LIVE';
  return 'ENDED';
}
