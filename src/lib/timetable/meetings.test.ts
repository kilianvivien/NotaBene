import { describe, expect, it } from 'vitest';
import { createCourse, type CourseMeeting } from '@/lib/schema';
import { timetableToIcs } from '@/lib/export/ics';
import {
  currentMeeting,
  lectureKey,
  meetingsOn,
  meetsOn,
  minutesToTime,
  normalizeMeeting,
  timeToMinutes,
} from './meetings';

const monday = 1;
const wednesday = 3;

function meeting(patch: Partial<CourseMeeting> = {}): CourseMeeting {
  return {
    id: 'm-1',
    title: null,
    weekdays: [monday],
    start: 10 * 60,
    end: 11 * 60 + 30,
    location: 'Amphi B',
    from: '2026-09-07',
    until: '2026-12-18',
    skip: [],
    templateId: null,
    importKey: null,
    ...patch,
  };
}

describe('times', () => {
  it('round-trips minutes and HH:MM', () => {
    expect(minutesToTime(630)).toBe('10:30');
    expect(minutesToTime(1440)).toBe('24:00');
    expect(timeToMinutes('10:30')).toBe(630);
    expect(timeToMinutes('9:05')).toBe(545);
    expect(timeToMinutes('24:00')).toBe(1440);
    expect(timeToMinutes('24:01')).toBeNull();
    expect(timeToMinutes('10:60')).toBeNull();
    expect(timeToMinutes('ten')).toBeNull();
  });
});

describe('meetsOn', () => {
  it('meets on its weekdays inside the term, and not on a skipped day', () => {
    const lecture = meeting({ skip: ['2026-11-02'] });
    expect(meetsOn(lecture, '2026-09-07')).toBe(true); // Monday, first day
    expect(meetsOn(lecture, '2026-09-08')).toBe(false); // Tuesday
    expect(meetsOn(lecture, '2026-08-31')).toBe(false); // before the term
    expect(meetsOn(lecture, '2026-12-21')).toBe(false); // after it
    expect(meetsOn(lecture, '2026-11-02')).toBe(false); // skipped Monday
  });

  it('keeps a 10:00 lecture at 10:00 across the clock change', () => {
    const course = createCourse({ name: 'Droit', meetings: [meeting()] });
    // Europe changes clocks on 25 October 2026; both Mondays start at 10:00.
    for (const day of ['2026-10-19', '2026-10-26']) {
      const [entry] = meetingsOn([course], day);
      expect(entry?.startsAt.getHours()).toBe(10);
      expect(entry?.startsAt.getMinutes()).toBe(0);
    }
  });
});

describe('currentMeeting', () => {
  const droit = createCourse({ name: 'Droit', meetings: [meeting()] });
  const at = (hours: number, minutes: number) => new Date(2026, 8, 14, hours, minutes);

  it('is the meeting within ten minutes of its start, until it ends', () => {
    expect(currentMeeting([droit], at(9, 49))).toBeNull();
    expect(currentMeeting([droit], at(9, 50))?.course.name).toBe('Droit');
    expect(currentMeeting([droit], at(11, 29))?.course.name).toBe('Droit');
    expect(currentMeeting([droit], at(11, 30))).toBeNull();
  });

  it('prefers the meeting under way to the one about to start', () => {
    const next = createCourse({
      name: 'Économie',
      meetings: [meeting({ id: 'm-2', start: 11 * 60 + 35, end: 13 * 60 })],
    });
    expect(currentMeeting([next, droit], at(11, 26))?.course.name).toBe('Droit');
  });

  it('ignores an archived course', () => {
    expect(currentMeeting([{ ...droit, archived: true }], at(10, 30))).toBeNull();
  });
});

describe('normalizeMeeting', () => {
  it('sorts and de-duplicates, and empties a blank location', () => {
    expect(
      normalizeMeeting(
        meeting({
          weekdays: [wednesday, monday, wednesday],
          skip: ['2026-11-11', '2026-11-02', '2026-11-11'],
          location: '   ',
        }),
      ),
    ).toMatchObject({
      weekdays: [monday, wednesday],
      skip: ['2026-11-02', '2026-11-11'],
      location: null,
    });
  });
});

it('keys a lecture note by meeting and day', () => {
  expect(lectureKey('m-1', '2026-09-07')).toBe('m-1:2026-09-07');
});

describe('timetableToIcs', () => {
  const course = createCourse({
    name: 'Droit constitutionnel',
    professor: 'Mme Dupont',
    meetings: [
      meeting({
        weekdays: [wednesday, monday],
        from: '2026-09-03', // a Thursday
        skip: ['2026-11-11', '2026-11-12'],
      }),
    ],
  });
  const { ics, exported } = timetableToIcs([course], { calendarName: 'NotaBene' });
  const lines = ics.split('\r\n');

  it('writes one recurring, floating event per meeting with a stable UID', () => {
    expect(exported).toBe(1);
    expect(lines).toContain('UID:meeting-m-1@notabene');
    expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261218T235959');
    expect(lines).toContain('SUMMARY:Droit constitutionnel');
    expect(lines).toContain('LOCATION:Amphi B');
  });

  it('starts on the first day it actually meets, not the term’s first day', () => {
    expect(lines).toContain('DTSTART:20260907T100000');
    expect(lines).toContain('DTEND:20260907T113000');
  });

  it('excludes skipped days at the meeting’s time, and only days it would meet', () => {
    // 11 November is a Wednesday; 12 November is a Thursday it never meets.
    expect(lines).toContain('EXDATE:20261111T100000');
  });

  it('exports nothing for a course without a timetable', () => {
    expect(timetableToIcs([createCourse({ name: 'Libre' })]).exported).toBe(0);
  });
});
