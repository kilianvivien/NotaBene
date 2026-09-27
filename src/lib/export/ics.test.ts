import { describe, expect, it } from 'vitest';
import { createTask, type Recurrence } from '@/lib/schema';
import { parseIcs, planCalendarImport } from '@/lib/import/ics';
import {
  durationBefore,
  escapeText,
  foldLine,
  recurrenceToRrule,
  tasksToIcs,
} from './ics';

const local = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi).toISOString();
const monthly = (monthDay: number | null): Recurrence => ({
  freq: 'monthly',
  interval: 1,
  weekdays: [],
  monthDay,
});

describe('the .ics writer', () => {
  it('escapes text and folds at 75 octets without splitting a character', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const line = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(
      folded
        .split('\r\n')
        .map((part, index) => (index ? part.slice(1) : part))
        .join(''),
    ).toBe(line);
  });

  it('writes a timed task as a floating short event with a stable UID and an alert', () => {
    const task = createTask({
      id: 'abc',
      title: 'Problem set, week 4',
      dueAt: local(2026, 3, 10, 8),
      remindAt: local(2026, 3, 9, 20),
    });
    const { ics, exported } = tasksToIcs([task]);
    expect(exported).toBe(1);
    expect(ics).toContain('UID:task-abc@notabene\r\n');
    expect(ics).toContain('DTSTART:20260310T080000\r\n');
    expect(ics).toContain('DURATION:PT30M\r\n');
    expect(ics).toContain('SUMMARY:Problem set\\, week 4\r\n');
    expect(ics).toContain('TRIGGER:-PT12H\r\n');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('writes a day with no time as an all-day event, and skips undated tasks', () => {
    const dated = createTask({ title: 'Essay', dueAt: local(2026, 3, 31) });
    const undated = createTask({ title: 'Someday' });
    const result = tasksToIcs([dated, undated]);
    expect(result.ics).toContain(
      'DTSTART;VALUE=DATE:20260331\r\nDTEND;VALUE=DATE:20260401',
    );
    expect(result.withoutDueDate).toBe(1);
  });

  it('titles a subtask with its parent', () => {
    const child = createTask({
      title: 'Outline',
      parentId: 'p',
      dueAt: local(2026, 3, 1, 9),
    });
    expect(
      tasksToIcs([child], { parentTitles: new Map([['p', 'Essay']]) }).ics,
    ).toContain('SUMMARY:Essay — Outline');
  });

  it('maps the recurrence presets, the monthly anchor included', () => {
    const due = new Date(2026, 0, 31, 9);
    expect(
      recurrenceToRrule(
        { freq: 'weekly', interval: 2, weekdays: [4, 2], monthDay: null },
        due,
      ),
    ).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH');
    expect(recurrenceToRrule(monthly(15), due)).toBe('FREQ=MONTHLY;BYMONTHDAY=15');
    expect(recurrenceToRrule(monthly(31), due)).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1',
    );
  });

  it('formats alarm offsets as durations', () => {
    expect(durationBefore(15 * 60_000)).toBe('-PT15M');
    expect(durationBefore(26 * 3_600_000)).toBe('-P1DT2H');
    expect(durationBefore(0)).toBe('PT0S');
    expect(durationBefore(-60_000)).toBe('PT1M');
  });

  it('round-trips through the importer back onto the same tasks', () => {
    const tasks = [
      createTask({
        id: 't1',
        title: 'Rent',
        dueAt: local(2099, 1, 31, 9),
        recurrence: monthly(31),
      }),
      createTask({
        id: 't2',
        title: 'Essay',
        dueAt: local(2099, 3, 31),
        remindAt: local(2099, 3, 30, 18),
      }),
    ];
    const plan = planCalendarImport(
      parseIcs(tasksToIcs(tasks).ics),
      tasks,
      local(2098, 12, 1),
    );
    expect(
      plan.tasks.map((task) => [task.existingId, task.status, task.fidelity]),
    ).toEqual([
      ['t1', 'unchanged', 'exact'],
      ['t2', 'unchanged', 'single'],
    ]);
  });
});
