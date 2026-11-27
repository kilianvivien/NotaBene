import { describe, expect, it } from 'vitest';
import { createCourse, type Course } from '@/lib/schema';
import { parseIcs } from './ics';
import {
  applyTimetableChoices,
  planTimetableImport,
  type GroupChoice,
} from './timetable';

/** The shape a school's weekly export has (inscal, 2026-11): one event per
 * session, the course in `CATEGORIES`, no `RRULE`. */
function week(events: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//timetable//FR',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}

function session(
  uid: string,
  start: string,
  end: string,
  summary: string,
  extra: string[] = [],
): string {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    // Floating, so the test reads the same in any timezone; `TZID` conversion
    // is the parser's and is tested there.
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    ...extra,
    'END:VEVENT',
  ].join('\r\n');
}

const firstWeek = week([
  session('a', '20261130T133000', '20261130T143000', 'Conférence sur la corruption', [
    'CATEGORIES:Parcours juridique',
    'LOCATION:Auditorium',
  ]),
  session('b', '20261130T103000', '20261130T120000', 'Ateliers de déontologie', [
    'CATEGORIES:Parcours juridique',
  ]),
  session('c', '20261201T084500', '20261201T104500', 'LV1', ['CATEGORIES:Langues']),
  session('d', '20261203T130000', '20261203T150000', 'Tronc commun', [
    'CATEGORIES:Tronc commun',
    'STATUS:CANCELLED',
  ]),
  session('e', '20261204T090000', '20261204T090000', 'Rendu du dossier'),
]);

const plan = (text: string, courses: Course[] = []) =>
  planTimetableImport(parseIcs(text), courses);

describe('planTimetableImport', () => {
  it('reads each session as one dated meeting, grouped by category, in time order', () => {
    const { groups } = plan(firstWeek);
    expect(groups.map((group) => [group.label, group.sessions.length])).toEqual([
      ['Langues', 1],
      ['Parcours juridique', 2],
    ]);
    const [morning, afternoon] = groups[1]!.sessions;
    expect(morning!.meeting).toMatchObject({
      title: 'Ateliers de déontologie',
      from: '2026-11-30',
      until: '2026-11-30',
      weekdays: [1],
      start: 10 * 60 + 30,
      end: 12 * 60,
      importKey: 'ics:b',
    });
    expect(afternoon!.meeting.location).toBe('Auditorium');
  });

  it('drops a cancelled session it never imported, and a deadline', () => {
    const { groups, skipped } = plan(firstWeek);
    expect(groups.some((group) => group.label === 'Tronc commun')).toBe(false);
    expect(skipped).toContainEqual({ summary: 'Rendu du dossier', reason: 'noEnd' });
  });

  it('suggests the course whose name matches the category, accents and case aside', () => {
    const course = createCourse({ id: 'c-1', name: 'parcours JURIDIQUE' });
    expect(plan(firstWeek, [course]).groups[1]!.suggestedCourseId).toBe('c-1');
  });

  it('reads a plain weekly series, with its excluded days', () => {
    const { groups } = plan(
      week([
        session('w', '20260907T100000', '20260907T113000', 'Droit', [
          'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261218T225959Z',
          'EXDATE;TZID=Europe/Paris:20261111T100000',
        ]),
      ]),
    );
    expect(groups[0]!.sessions[0]!.meeting).toMatchObject({
      weekdays: [1, 3],
      from: '2026-09-07',
      until: '2026-12-18',
      skip: ['2026-11-11'],
    });
  });

  it('skips a repetition a meeting cannot hold', () => {
    const { skipped } = plan(
      week([
        session('m', '20260907T100000', '20260907T113000', 'Monthly', [
          'RRULE:FREQ=MONTHLY;COUNT=3',
        ]),
      ]),
    );
    expect(skipped).toEqual([{ summary: 'Monthly', reason: 'unsupportedRepeat' }]);
  });
});

describe('a re-import of the same week', () => {
  const choices = new Map<string, GroupChoice>([
    ['parcours juridique', { kind: 'course', courseId: 'c-1' }],
    ['langues', { kind: 'skip' }],
  ]);

  function imported(): Course {
    const course = createCourse({ id: 'c-1', name: 'Juridique' });
    const first = plan(firstWeek, [course]);
    const { meetings } = applyTimetableChoices(first, [course], choices);
    return { ...course, meetings: meetings.get('c-1')! };
  }

  it('writes only the mapped groups', () => {
    expect(imported().meetings.map((meeting) => meeting.importKey)).toEqual([
      'ics:b',
      'ics:a',
    ]);
  });

  it('changes nothing when nothing changed', () => {
    const course = imported();
    const again = plan(firstWeek, [course]);
    expect(again.groups[1]!.sessions.map((entry) => entry.status)).toEqual([
      'unchanged',
      'unchanged',
    ]);
  });

  it('moves a session that moved, and removes one that was cancelled', () => {
    const course = imported();
    const next = week([
      session('a', '20261130T140000', '20261130T150000', 'Conférence sur la corruption', [
        'CATEGORIES:Parcours juridique',
        'LOCATION:Auditorium',
      ]),
      session('b', '20261130T103000', '20261130T120000', 'Ateliers de déontologie', [
        'CATEGORIES:Parcours juridique',
        'STATUS:CANCELLED',
      ]),
    ]);
    const update = plan(next, [course]);
    const result = applyTimetableChoices(update, [course], choices);
    expect([result.updated, result.removed, result.added]).toEqual([1, 1, 0]);
    expect(result.meetings.get('c-1')!.map((meeting) => meeting.start)).toEqual([
      14 * 60,
    ]);
  });
});
