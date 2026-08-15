/**
 * Where a repeating task lands next.
 *
 * Exactly one occurrence of a recurring task exists at a time: completing it
 * rolls the due date forward rather than closing the task. That is what keeps
 * "every Tuesday" from materialising a hundred rows nobody asked for, and it is
 * why this file only ever has to answer one question.
 *
 * The arithmetic runs in local time and is re-serialised, so a task due at 08:00
 * every day is still due at 08:00 the morning the clocks change. Doing it in UTC
 * would silently move it to 07:00 or 09:00 for half the year.
 */
import type { Recurrence } from '@/lib/schema';

/** Days in a month, for the clamp below. `month` is 0-indexed, as `Date` has it. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * The first occurrence strictly after `from`.
 *
 * `from` is normally the task's current due date. Passing "now" instead is what
 * a student who completes a weekly task three weeks late wants: the next
 * occurrence should be the one ahead of them, not the one they already missed.
 */
export function nextOccurrence(from: string, rule: Recurrence): string {
  const start = new Date(from);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`RECURRENCE_INVALID_DATE: ${from}`);
  }
  const interval = Math.max(1, Math.trunc(rule.interval));

  switch (rule.freq) {
    case 'daily':
      return shiftDays(start, interval);

    case 'weekly': {
      // No weekdays named means "this same weekday, every N weeks".
      const weekdays = [...new Set(rule.weekdays)].sort((a, b) => a - b);
      if (!weekdays.length) return shiftDays(start, 7 * interval);

      // Within the current week there may be another listed day still ahead;
      // "Tuesdays and Thursdays" must produce Thursday before next Tuesday.
      const current = start.getDay();
      const later = weekdays.find((day) => day > current);
      if (later !== undefined) return shiftDays(start, later - current);

      // Otherwise jump to the first listed day of the week `interval` weeks on.
      const first = weekdays[0] as number;
      return shiftDays(start, 7 * interval - current + first);
    }

    case 'monthly': {
      const target = new Date(start);
      const day = start.getDate();
      // Set the day to 1 before moving the month: `new Date(2026, 0, 31)` plus
      // one month is 3 March, not February, because JavaScript overflows rather
      // than clamps.
      target.setDate(1);
      target.setMonth(target.getMonth() + interval);
      target.setDate(Math.min(day, daysInMonth(target.getFullYear(), target.getMonth())));
      return target.toISOString();
    }
  }
}

function shiftDays(start: Date, days: number): string {
  const next = new Date(start);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

/**
 * Roll a recurring task forward past `now`.
 *
 * A task completed on time advances one step. One completed three weeks late
 * advances until it is in the future, so the student is not handed a due date
 * that is already overdue the moment they tick the box. The loop is bounded
 * because a malformed rule must not hang the app.
 */
export function nextOccurrenceAfter(from: string, rule: Recurrence, now: string): string {
  let candidate = nextOccurrence(from, rule);
  for (let step = 0; step < 500 && candidate <= now; step += 1) {
    candidate = nextOccurrence(candidate, rule);
  }
  return candidate;
}

/**
 * Carry a reminder forward by the same distance the due date moved, preserving
 * "remind me the evening before" across a rollover.
 */
export function shiftReminder(
  remindAt: string | null,
  previousDueAt: string | null,
  nextDueAt: string,
): string | null {
  if (!remindAt) return null;
  // With no previous due date there is no offset to preserve; the reminder is
  // absolute and stays where the student put it.
  if (!previousDueAt) return remindAt;
  const offset = new Date(previousDueAt).getTime() - new Date(remindAt).getTime();
  return new Date(new Date(nextDueAt).getTime() - offset).toISOString();
}
