import { describe, expect, it } from 'vitest';
import { localDay, resolveSubtaskDue } from './taskAssist';

/** Local noon, so the assertions do not straddle a day boundary in any zone. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('localDay', () => {
  it('reports the day the student is living in, not the UTC one', () => {
    // 23:30 local on the 16th is the 17th in UTC east of Greenwich and the
    // 16th west of it. The student's calendar says the 16th either way.
    expect(localDay(at(2026, 8, 16, 23, 30))).toBe('2026-08-16');
    expect(localDay(at(2026, 1, 1, 0, 5))).toBe('2026-01-01');
  });
});

describe('resolveSubtaskDue', () => {
  const now = at(2026, 8, 16);
  const parentDue = at(2026, 8, 20, 9, 0).toISOString();

  it('gives a step the parent’s own time of day', () => {
    const resolved = resolveSubtaskDue(
      '2026-08-18',
      at(2026, 8, 20, 17, 30).toISOString(),
      now,
    );
    const date = new Date(resolved!);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(7);
    expect(date.getDate()).toBe(18);
    expect(date.getHours()).toBe(17);
    expect(date.getMinutes()).toBe(30);
  });

  it('falls back to 09:00 when the parent has no deadline', () => {
    const date = new Date(resolveSubtaskDue('2026-08-18', null, now)!);
    expect(date.getDate()).toBe(18);
    expect(date.getHours()).toBe(9);
  });

  it('never lands a step after the work it belongs to', () => {
    expect(resolveSubtaskDue('2026-08-25', parentDue, now)).toBe(parentDue);
  });

  it('drops a day already past rather than creating an overdue step', () => {
    expect(resolveSubtaskDue('2026-08-10', parentDue, now)).toBeNull();
  });

  it('keeps today, which is not past', () => {
    expect(resolveSubtaskDue('2026-08-16', parentDue, now)).not.toBeNull();
  });

  it('has no opinion when the model gave no day', () => {
    expect(resolveSubtaskDue(undefined, parentDue, now)).toBeNull();
  });

  it('refuses a day it cannot read', () => {
    expect(resolveSubtaskDue('next Tuesday', parentDue, now)).toBeNull();
    expect(resolveSubtaskDue('2026-13-40', parentDue, now)).not.toBe('2026-13-40');
  });
});
