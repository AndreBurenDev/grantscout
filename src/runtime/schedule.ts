// Cron evaluation for the in-process scheduler. All schedules are Amsterdam wall-clock time.
import cronParser from 'cron-parser';

export interface ScheduleEntry { id: string; cron: string; enabled: boolean }

export const SCHEDULE_TZ = 'Europe/Amsterdam';

export function lastTickAtOrBefore(cron: string, now: Date): Date | null {
  try {
    const it = cronParser.parseExpression(cron, { currentDate: new Date(now.getTime() + 1), tz: SCHEDULE_TZ });
    return it.prev().toDate();
  } catch {
    return null;
  }
}

export function isValidCron(cron: string): boolean {
  try { cronParser.parseExpression(cron, { tz: SCHEDULE_TZ }); return true; } catch { return false; }
}

/** Due iff enabled and its latest tick is after its last start → at most ONE catch-up per entry after downtime. */
export function dueEntries(entries: ScheduleEntry[], lastStarted: Record<string, string>, now: Date): ScheduleEntry[] {
  return entries.filter((e) => {
    if (!e.enabled) return false;
    const tick = lastTickAtOrBefore(e.cron, now);
    if (!tick) return false;
    const last = lastStarted[e.id];
    return !last || new Date(last).getTime() < tick.getTime();
  });
}
