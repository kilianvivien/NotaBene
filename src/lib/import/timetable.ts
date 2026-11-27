/**
 * A calendar file read as a timetable (plan §4 item 1). Pure: it plans, the
 * command writes.
 *
 * What a school's export actually looks like decided the shape (a real INSP
 * week from inscal, 2026-11-27): no `RRULE` at all, one event per session,
 * times in a `TZID`, the course in `CATEGORIES`, the session's own title in
 * `SUMMARY`, and called-off sessions kept with `STATUS:CANCELLED`. Students
 * re-import it every week. So:
 *
 * - **A session is a dated meeting** — `from === until`, one weekday. Weekly
 *   repetition is the exception, read only from a plain weekly `RRULE`.
 * - **Identity is the UID** (`ics:{UID}`), so next week's file adds its new
 *   sessions, updates moved ones, and removes cancelled ones, without
 *   touching anything the student typed.
 * - **Grouping is by category,** matched to a course by name. A group the
 *   student has not mapped is never written.
 *
 * Times become floating local minutes from the instant the parser produced —
 * the wall-clock time the student will live the lecture at.
 */
import type { IcsEvent, IcsParse } from './ics';
import { looksLikeDeadline } from './ics';
import { fold } from '@/lib/search/fold';
import type { Course, CourseMeeting } from '@/lib/schema';
import { localDay } from '@/lib/utils/calendar';
import { newId } from '@/lib/schema';

export type TimetableSkipReason =
  'allDay' | 'noEnd' | 'multiDay' | 'deadline' | 'unsupportedRepeat' | 'override';

export interface PlannedSession {
  importKey: string;
  /** The meeting as it would be written, keeping the existing id on update. */
  meeting: CourseMeeting;
  /** The course and meeting this session already is, from an earlier import. */
  existing: { courseId: string; meetingId: string } | null;
  status: 'new' | 'changed' | 'unchanged' | 'cancelled';
}

export interface TimetableGroup {
  /** Folded category, or `''` for events with none. */
  key: string;
  /** The category as the file spells it; `null` for the uncategorised. */
  label: string | null;
  /** The course a name match suggests, or the course its sessions already
   * live in. `null` when the student has to choose. */
  suggestedCourseId: string | null;
  sessions: PlannedSession[];
}

export interface TimetablePlan {
  groups: TimetableGroup[];
  skipped: { summary: string; reason: TimetableSkipReason }[];
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

function minutesOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** `FREQ=WEEKLY` with an optional `BYDAY`, `UNTIL` or `COUNT`, and nothing
 * else — the only repetition a meeting can hold exactly. */
function weeklyRule(
  rrule: string,
  start: Date,
): { weekdays: number[]; until: string | null; count: number | null } | null {
  const parts = new Map(
    rrule.split(';').map((part) => {
      const [name = '', value = ''] = part.split('=');
      return [name.toUpperCase(), value.toUpperCase()] as const;
    }),
  );
  if (parts.get('FREQ') !== 'WEEKLY') return null;
  if ((parts.get('INTERVAL') ?? '1') !== '1') return null;
  for (const name of parts.keys()) {
    if (!['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT', 'WKST'].includes(name))
      return null;
  }
  const byDay = parts.get('BYDAY');
  const weekdays = byDay
    ? byDay.split(',').map((code) => WEEKDAY_CODES.indexOf(code as never))
    : [start.getDay()];
  if (weekdays.some((day) => day < 0)) return null;
  const untilRaw = parts.get('UNTIL');
  let until: string | null = null;
  if (untilRaw) {
    const match = /^(\d{4})(\d{2})(\d{2})/.exec(untilRaw);
    if (!match) return null;
    until = `${match[1]}-${match[2]}-${match[3]}`;
  }
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;
  if (count !== null && !(count > 0)) return null;
  return { weekdays: [...new Set(weekdays)].sort((a, b) => a - b), until, count };
}

/** The last day of a weekly series that stops after `count` meetings. */
function untilForCount(from: Date, weekdays: number[], count: number): string {
  let met = 0;
  const day = new Date(from);
  // Bounded: a count of n on one weekday ends within 7n days.
  for (let step = 0; step < count * 7 + 7; step += 1) {
    if (weekdays.includes(day.getDay())) {
      met += 1;
      if (met === count) return localDay(day);
    }
    day.setDate(day.getDate() + 1);
  }
  return localDay(day);
}

type Read = { meeting: Omit<CourseMeeting, 'id'> } | { skip: TimetableSkipReason };

function readSession(event: IcsEvent): Read {
  if (event.overridesOccurrence) return { skip: 'override' };
  if (event.allDay) return { skip: 'allDay' };
  if (event.durationMinutes === null || event.durationMinutes <= 0)
    return { skip: 'noEnd' };
  // A deadline is a task, not a class; the task import keeps it.
  if (looksLikeDeadline(event)) return { skip: 'deadline' };
  const startsAt = new Date(event.start);
  const endsAt = new Date(startsAt.getTime() + event.durationMinutes * 60_000);
  const day = localDay(startsAt);
  // A session that runs past midnight is not a lecture a note is ready for.
  if (localDay(new Date(endsAt.getTime() - 1)) !== day) return { skip: 'multiDay' };
  const start = minutesOf(startsAt);
  const end = minutesOf(endsAt) || 24 * 60 - 1;

  const base = {
    title: event.summary.trim().slice(0, 300) || null,
    start,
    end,
    location: event.location,
    from: day,
    skip: [] as string[],
    templateId: null,
    importKey: `ics:${event.uid}`.slice(0, 2_000),
  };
  if (!event.rrule) {
    return { meeting: { ...base, weekdays: [startsAt.getDay()], until: day } };
  }
  const rule = weeklyRule(event.rrule, startsAt);
  // An endless series has no term to hold; the student can set one by hand.
  if (!rule || (!rule.until && !rule.count)) return { skip: 'unsupportedRepeat' };
  const until = rule.until ?? untilForCount(startsAt, rule.weekdays, rule.count!);
  return {
    meeting: {
      ...base,
      weekdays: rule.weekdays,
      until,
      skip: [...new Set(event.exdates.map((iso) => localDay(new Date(iso))))].sort(),
    },
  };
}

const sameMeeting = (a: Omit<CourseMeeting, 'id'>, b: CourseMeeting) =>
  a.title === b.title &&
  a.start === b.start &&
  a.end === b.end &&
  a.location === b.location &&
  a.from === b.from &&
  a.until === b.until &&
  JSON.stringify(a.weekdays) === JSON.stringify(b.weekdays) &&
  JSON.stringify(a.skip) === JSON.stringify(b.skip);

export function planTimetableImport(
  parse: IcsParse,
  courses: readonly Course[],
): TimetablePlan {
  const known = new Map<string, { course: Course; meeting: CourseMeeting }>();
  for (const course of courses) {
    for (const meeting of course.meetings) {
      if (meeting.importKey) known.set(meeting.importKey, { course, meeting });
    }
  }
  const byName = new Map(
    courses
      .filter((course) => !course.archived)
      .map((course) => [fold(course.name), course]),
  );

  const groups = new Map<string, TimetableGroup>();
  const skipped: TimetablePlan['skipped'] = [];
  const seen = new Set<string>();

  for (const event of parse.events) {
    if (event.kind !== 'event') continue;
    const importKey = `ics:${event.uid}`.slice(0, 2_000);
    if (seen.has(importKey)) continue;
    seen.add(importKey);
    const previous = known.get(importKey) ?? null;
    const label = event.categories[0] ?? null;
    const key = label ? fold(label) : '';

    let session: PlannedSession | null = null;
    if (event.cancelled) {
      // Only news when it cancels something already in the timetable.
      if (previous) {
        session = {
          importKey,
          meeting: previous.meeting,
          existing: { courseId: previous.course.id, meetingId: previous.meeting.id },
          status: 'cancelled',
        };
      }
    } else {
      const read = readSession(event);
      if ('skip' in read) {
        skipped.push({ summary: event.summary, reason: read.skip });
      } else {
        session = {
          importKey,
          meeting: { ...read.meeting, id: previous?.meeting.id ?? newId() },
          existing: previous
            ? { courseId: previous.course.id, meetingId: previous.meeting.id }
            : null,
          status: !previous
            ? 'new'
            : sameMeeting(read.meeting, previous.meeting)
              ? 'unchanged'
              : 'changed',
        };
        // Keep what the student chose for this meeting by hand.
        if (previous) session.meeting.templateId = previous.meeting.templateId;
      }
    }
    if (!session) continue;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label,
        suggestedCourseId:
          previous?.course.id ?? (label ? byName.get(key)?.id : null) ?? null,
        sessions: [],
      };
      groups.set(key, group);
    }
    if (!group.suggestedCourseId && previous)
      group.suggestedCourseId = previous.course.id;
    group.sessions.push(session);
  }

  const ordered = [...groups.values()];
  for (const group of ordered) {
    group.sessions.sort(
      (a, b) =>
        a.meeting.from.localeCompare(b.meeting.from) || a.meeting.start - b.meeting.start,
    );
  }
  // Named groups first, alphabetically; the uncategorised last.
  ordered.sort((a, b) =>
    !a.label
      ? 1
      : !b.label
        ? -1
        : a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
  return { groups: ordered, skipped };
}

/** How the student answered for one group in the preview. */
export type GroupChoice =
  { kind: 'course'; courseId: string } | { kind: 'new'; name: string } | { kind: 'skip' };

/**
 * The courses' new timetables, given the student's choices — still pure, so
 * the command only creates the new courses and writes what this returns.
 *
 * A session already in a course stays in that course whatever the group's
 * choice: moving lectures between courses is the course editor's job, and a
 * re-import must not do it silently. A new course is addressed by a
 * placeholder id the command replaces.
 */
export function applyTimetableChoices(
  plan: TimetablePlan,
  courses: readonly Course[],
  choices: ReadonlyMap<string, GroupChoice>,
): {
  meetings: Map<string, CourseMeeting[]>;
  added: number;
  updated: number;
  removed: number;
} {
  const meetings = new Map(courses.map((course) => [course.id, [...course.meetings]]));
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const group of plan.groups) {
    const choice = choices.get(group.key) ?? { kind: 'skip' };
    for (const session of group.sessions) {
      if (session.existing) {
        const list = meetings.get(session.existing.courseId);
        if (!list) continue;
        const index = list.findIndex(
          (meeting) => meeting.id === session.existing!.meetingId,
        );
        if (index < 0) continue;
        if (session.status === 'cancelled') {
          list.splice(index, 1);
          removed += 1;
        } else if (session.status === 'changed') {
          list[index] = session.meeting;
          updated += 1;
        }
        continue;
      }
      if (choice.kind === 'skip') continue;
      const target = choice.kind === 'course' ? choice.courseId : `new:${group.key}`;
      const list = meetings.get(target) ?? [];
      list.push(session.meeting);
      meetings.set(target, list);
      added += 1;
    }
  }
  return { meetings, added, updated, removed };
}
