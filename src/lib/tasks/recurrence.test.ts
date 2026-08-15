import { describe, expect, it } from 'vitest';
import type { Recurrence } from '@/lib/schema';
import { nextOccurrence, nextOccurrenceAfter, shiftReminder } from './recurrence';

/** Local-time construction, because that is the frame the rules work in. */
function at(
  year: number,
  month: number,
  day: number,
  hour = 9,
  minute = 0,
): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function localParts(iso: string): [number, number, number, number, number] {
  const date = new Date(iso);
  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  ];
}

const daily: Recurrence = { freq: 'daily', interval: 1, weekdays: [] };

describe('nextOccurrence', () => {
  it('advances a daily task by its interval', () => {
    expect(localParts(nextOccurrence(at(2026, 8, 15), daily))).toEqual([
      2026, 8, 16, 9, 0,
    ]);
    expect(
      localParts(nextOccurrence(at(2026, 8, 15), { ...daily, interval: 3 })),
    ).toEqual([2026, 8, 18, 9, 0]);
  });

  it('keeps the time of day across a daylight-saving boundary', () => {
    // Whatever the runner's zone, an 08:00 task stays an 08:00 task — the point
    // of doing the arithmetic in local time rather than in UTC.
    for (const day of [1, 8, 15, 22, 29]) {
      const next = nextOccurrence(at(2026, 3, day, 8, 0), daily);
      expect(localParts(next).slice(3)).toEqual([8, 0]);
    }
  });

  it('rolls a weekly task to the next listed weekday before jumping a week', () => {
    // 2026-08-11 is a Tuesday; the rule is Tuesdays and Thursdays.
    const rule: Recurrence = { freq: 'weekly', interval: 1, weekdays: [2, 4] };
    const thursday = nextOccurrence(at(2026, 8, 11), rule);
    expect(localParts(thursday).slice(0, 3)).toEqual([2026, 8, 13]);

    // From Thursday there is nothing later in the week, so it wraps to Tuesday.
    const nextTuesday = nextOccurrence(thursday, rule);
    expect(localParts(nextTuesday).slice(0, 3)).toEqual([2026, 8, 18]);
  });

  it('treats a weekly rule with no weekdays as "this same day, every N weeks"', () => {
    const rule: Recurrence = { freq: 'weekly', interval: 2, weekdays: [] };
    expect(localParts(nextOccurrence(at(2026, 8, 11), rule)).slice(0, 3)).toEqual([
      2026, 8, 25,
    ]);
  });

  it('crosses a month boundary on a weekly rule', () => {
    const rule: Recurrence = { freq: 'weekly', interval: 1, weekdays: [] };
    expect(localParts(nextOccurrence(at(2026, 8, 27), rule)).slice(0, 3)).toEqual([
      2026, 9, 3,
    ]);
  });

  it('clamps a monthly task rather than overflowing into the next month', () => {
    const rule: Recurrence = { freq: 'monthly', interval: 1, weekdays: [] };
    // The 31st of January has no counterpart in February; it must land on the
    // 28th, not spill over into March the way `setMonth` alone would.
    expect(localParts(nextOccurrence(at(2026, 1, 31), rule)).slice(0, 3)).toEqual([
      2026, 2, 28,
    ]);
    expect(localParts(nextOccurrence(at(2026, 3, 31), rule)).slice(0, 3)).toEqual([
      2026, 4, 30,
    ]);
  });

  it('clamps to 29 February in a leap year', () => {
    const rule: Recurrence = { freq: 'monthly', interval: 1, weekdays: [] };
    expect(localParts(nextOccurrence(at(2028, 1, 31), rule)).slice(0, 3)).toEqual([
      2028, 2, 29,
    ]);
  });

  it('advances a monthly task across a year boundary', () => {
    const rule: Recurrence = { freq: 'monthly', interval: 2, weekdays: [] };
    expect(localParts(nextOccurrence(at(2026, 11, 15), rule)).slice(0, 3)).toEqual([
      2027, 1, 15,
    ]);
  });

  it('refuses a date it cannot read instead of returning an invalid one', () => {
    expect(() => nextOccurrence('not a date', daily)).toThrow(/RECURRENCE_INVALID_DATE/);
  });
});

describe('nextOccurrenceAfter', () => {
  it('does not hand back a due date that is already overdue', () => {
    // Completed three weeks late: the next occurrence should be ahead of the
    // student, not the one they already missed.
    const next = nextOccurrenceAfter(at(2026, 8, 1), daily, at(2026, 8, 22));
    expect(localParts(next).slice(0, 3)).toEqual([2026, 8, 23]);
  });

  it('advances exactly one step when the task is completed on time', () => {
    const next = nextOccurrenceAfter(at(2026, 8, 20), daily, at(2026, 8, 19, 18));
    expect(localParts(next).slice(0, 3)).toEqual([2026, 8, 21]);
  });
});

describe('shiftReminder', () => {
  it('preserves "the evening before" across a rollover', () => {
    const previousDue = at(2026, 8, 20, 9, 0);
    const remindAt = at(2026, 8, 19, 20, 0);
    const nextDue = at(2026, 8, 27, 9, 0);

    const shifted = shiftReminder(remindAt, previousDue, nextDue);

    expect(shifted).not.toBeNull();
    expect(localParts(shifted as string)).toEqual([2026, 8, 26, 20, 0]);
  });

  it('leaves an absolute reminder alone when there was no due date to offset from', () => {
    const remindAt = at(2026, 8, 19, 20, 0);
    expect(shiftReminder(remindAt, null, at(2026, 8, 27))).toBe(remindAt);
  });

  it('has nothing to shift when there is no reminder', () => {
    expect(shiftReminder(null, at(2026, 8, 20), at(2026, 8, 27))).toBeNull();
  });
});
