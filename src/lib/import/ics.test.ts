import { describe, expect, it } from 'vitest';
import { createTask } from '@/lib/schema';
import {
  IcsRefusal,
  looksLikeDeadline,
  mapRrule,
  parseIcs,
  parseIcsDate,
  parseIcsDuration,
  planCalendarImport,
  selectCalendarTasks,
  unescapeText,
} from './ics';

const local = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi).toISOString();

function calendar(...events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
}

const MOODLE = [
  'BEGIN:VEVENT',
  'UID:1234@moodle.example.edu',
  'SUMMARY:Essay 2 is due',
  'DESCRIPTION:Submit via the course page\\, as a PDF.',
  'DTSTART:20990310T225900Z',
  'DTEND:20990310T225900Z',
  'BEGIN:VALARM',
  'TRIGGER:-PT1H',
  'ACTION:DISPLAY',
  'END:VALARM',
  'END:VEVENT',
].join('\r\n');

const LECTURE = [
  'BEGIN:VEVENT',
  'UID:lecture@uni',
  'SUMMARY:Analysis I — lecture',
  'DTSTART;TZID=Europe/Paris:20260105T100000',
  'DTEND;TZID=Europe/Paris:20260105T120000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT',
].join('\r\n');

describe('parseIcs', () => {
  it('unfolds, unescapes, and reads events, alarms and durations', () => {
    const folded = MOODLE.replace(
      'SUMMARY:Essay 2 is due',
      'SUMMARY:Essay 2\r\n  is due',
    );
    const { events } = parseIcs(calendar(folded));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'event',
      uid: '1234@moodle.example.edu',
      summary: 'Essay 2 is due',
      description: 'Submit via the course page, as a PDF.',
      start: '2099-03-10T22:59:00.000Z',
      allDay: false,
      durationMinutes: 0,
      alarmBeforeMs: 3_600_000,
    });
  });

  it('converts a TZID time through the zone, not the machine', () => {
    expect(parseIcsDate('20260105T100000', { TZID: 'Europe/Paris' })?.iso).toBe(
      '2026-01-05T09:00:00.000Z',
    );
    expect(parseIcsDate('20260705T100000', { TZID: 'Europe/Paris' })?.iso).toBe(
      '2026-07-05T08:00:00.000Z',
    );
    const warnings: { code: string; count: number }[] = [];
    parseIcsDate('20260105T100000', { TZID: 'Romance Standard Time' }, warnings);
    expect(warnings).toEqual([{ code: 'unknownTimezone', count: 1 }]);
  });

  it('reads a date alone as an all-day local midnight', () => {
    expect(parseIcsDate('20260331', { VALUE: 'DATE' })).toEqual({
      iso: local(2026, 3, 31),
      allDay: true,
    });
  });

  it('reads to-dos by their due date and skips events without a date', () => {
    const todo = [
      'BEGIN:VTODO',
      'UID:t',
      'SUMMARY:Read ch. 3',
      'DUE;VALUE=DATE:20990401',
      'STATUS:COMPLETED',
      'END:VTODO',
    ].join('\r\n');
    const undated = ['BEGIN:VEVENT', 'UID:u', 'SUMMARY:Floating', 'END:VEVENT'].join(
      '\r\n',
    );
    const parsed = parseIcs(calendar(todo, undated, 'BEGIN:VJOURNAL', 'END:VJOURNAL'));
    expect(parsed.events.map((event) => [event.kind, event.completed])).toEqual([
      ['todo', true],
    ]);
    expect(parsed.skipped).toEqual([
      { summary: 'Floating', reason: 'noDate' },
      { summary: 'VJOURNAL', reason: 'unsupported' },
    ]);
  });

  it('refuses what is not a calendar, and what is too big, before parsing', () => {
    expect(() => parseIcs('hello')).toThrow(new IcsRefusal('notCalendar'));
    const many = Array.from({ length: 5_001 }, () => 'BEGIN:VEVENT\r\nEND:VEVENT');
    expect(() => parseIcs(calendar(...many))).toThrow(new IcsRefusal('tooManyEvents'));
  });

  it('parses durations and escapes', () => {
    expect(parseIcsDuration('-PT15M')).toBe(-900_000);
    expect(parseIcsDuration('P1W')).toBe(604_800_000);
    expect(parseIcsDuration('P1DT2H')).toBe(93_600_000);
    expect(parseIcsDuration('P')).toBeNull();
    expect(unescapeText('a\\, b\\; c\\\\ d\\ne')).toBe('a, b; c\\ d\ne');
  });
});

describe('mapRrule', () => {
  const start = local(2026, 1, 31, 9);
  it('maps what fits the three presets exactly', () => {
    expect(mapRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', start)).toMatchObject({
      fidelity: 'exact',
      recurrence: { freq: 'weekly', interval: 2, weekdays: [2, 4] },
    });
    expect(
      mapRrule('FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1', start).recurrence
        ?.monthDay,
    ).toBe(31);
    expect(mapRrule('FREQ=MONTHLY', start).recurrence?.monthDay).toBe(31);
  });

  it('simplifies an ending series and refuses shapes it has no preset for', () => {
    expect(mapRrule('FREQ=DAILY;COUNT=5', start).fidelity).toBe('simplified');
    expect(mapRrule('FREQ=MONTHLY;BYDAY=1MO', start).fidelity).toBe('unsupported');
    expect(mapRrule('FREQ=YEARLY', start).fidelity).toBe('unsupported');
    expect(mapRrule('FREQ=WEEKLY;BYHOUR=9', start).fidelity).toBe('unsupported');
  });
});

describe('planCalendarImport', () => {
  const now = local(2026, 1, 20, 12);

  it('keeps deadlines by default and leaves class meetings out', () => {
    const plan = planCalendarImport(parseIcs(calendar(MOODLE, LECTURE)), [], now);
    const lecture = plan.tasks.find((task) => task.event.uid === 'lecture@uni')!;
    expect(looksLikeDeadline(lecture.event)).toBe(false);
    // The weekly lecture stands for its series, so it is due next Monday.
    expect(lecture.recurrence).toMatchObject({ freq: 'weekly', weekdays: [1] });
    expect(lecture.dueAt >= now).toBe(true);
    const kept = selectCalendarTasks(plan, { which: 'deadlines', includePast: false });
    expect(kept.map((task) => task.title)).toEqual(['Essay 2 is due']);
    expect(kept[0]!.remindAt).toBe('2099-03-10T21:59:00.000Z');
  });

  it('updates what it imported before instead of doubling it', () => {
    const first = planCalendarImport(parseIcs(calendar(MOODLE)), [], now);
    const imported = createTask({
      id: 'existing',
      title: first.tasks[0]!.title,
      details: first.tasks[0]!.details,
      dueAt: first.tasks[0]!.dueAt,
      remindAt: first.tasks[0]!.remindAt,
      importKey: 'ics:1234@moodle.example.edu',
    });
    expect(
      planCalendarImport(parseIcs(calendar(MOODLE)), [imported], now).tasks[0],
    ).toMatchObject({
      existingId: 'existing',
      status: 'unchanged',
    });
    const moved = MOODLE.replace(/20990310T225900Z/g, '20990312T225900Z');
    expect(
      planCalendarImport(parseIcs(calendar(moved)), [imported], now).tasks[0]!.status,
    ).toBe('changed');
  });

  it('leaves out occurrence overrides and past one-off events by default', () => {
    const past = MOODLE.replace(/2099/g, '2025').replace('1234@', 'old@');
    const override = LECTURE.replace(
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'RECURRENCE-ID:20260112T100000',
    );
    const plan = planCalendarImport(parseIcs(calendar(past, override)), [], now);
    expect(plan.overrides).toBe(1);
    expect(selectCalendarTasks(plan, { which: 'all', includePast: false })).toEqual([]);
    expect(selectCalendarTasks(plan, { which: 'all', includePast: true })).toHaveLength(
      1,
    );
  });
});
