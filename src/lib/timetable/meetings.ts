/**
 * A course's timetable, read (plan §4 items 1–2).
 *
 * Everything here is pure and works in **floating local time**: a meeting is
 * "Mondays at 10:00", never an instant, so a clock change moves nothing. A day
 * is a `YYYY-MM-DD` string in the student's own timezone (`localDay`), which
 * also makes `from`/`until`/`skip` comparable as strings.
 */
import { addDays, localDay } from '@/lib/utils/calendar';
import { newId, type Course, type CourseMeeting } from '@/lib/schema';

export { localDay };

export const MINUTES_PER_DAY = 24 * 60;
/** How long before a meeting it counts as "now" for the sidebar line. */
export const NOW_LEAD_MINUTES = 10;
/** A new meeting's term: fifteen weeks, about a European semester. */
const DEFAULT_TERM_DAYS = 15 * 7 - 1;

/** `630` → `"10:30"`. `1440` reads as `"24:00"`, the end of the day. */
export function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `"10:30"` → `630`; `null` for anything an `<input type="time">` would not
 * produce. `"24:00"` is accepted as the end of the day. */
export function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total <= MINUTES_PER_DAY ? total : null;
}

/** The day `YYYY-MM-DD` names, at local midnight. */
export function parseLocalDay(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
}

/** A meeting as the editor starts one: one session today, 10:00 to 11:30.
 * Repeating weekly is a choice the student makes (`repeatWeekly`). */
export function createMeeting(today: Date = new Date()): CourseMeeting {
  return {
    id: newId(),
    title: null,
    weekdays: [today.getDay()],
    start: 10 * 60,
    end: 11 * 60 + 30,
    location: null,
    from: localDay(today),
    until: localDay(today),
    skip: [],
    templateId: null,
    importKey: null,
  };
}

/** Sorted, de-duplicated weekdays and skipped days, and a trimmed location
 * that is `null` when empty — so two edits that mean the same meeting store
 * the same bytes. */
export function normalizeMeeting(meeting: CourseMeeting): CourseMeeting {
  const location = meeting.location?.trim() ?? '';
  const title = meeting.title?.trim() ?? '';
  const single = meeting.from === meeting.until;
  return {
    ...meeting,
    title: title || null,
    // A single session meets on its own day, whatever was ticked before the
    // student turned repetition off.
    weekdays: single
      ? [parseLocalDay(meeting.from).getDay()]
      : [...new Set(meeting.weekdays)].sort((a, b) => a - b),
    skip: single ? [] : [...new Set(meeting.skip)].sort(),
    location: location || null,
  };
}

export function repeatsWeekly(meeting: CourseMeeting): boolean {
  return meeting.until > meeting.from;
}

/** Turn weekly repetition on (for a semester from the session's day) or off
 * (back to the one session). */
export function repeatWeekly(meeting: CourseMeeting, on: boolean): CourseMeeting {
  if (!on) return normalizeMeeting({ ...meeting, until: meeting.from });
  if (repeatsWeekly(meeting)) return meeting;
  return {
    ...meeting,
    until: localDay(addDays(parseLocalDay(meeting.from), DEFAULT_TERM_DAYS)),
  };
}

/** Whether `meeting` takes place on `day` (a `YYYY-MM-DD`). */
export function meetsOn(meeting: CourseMeeting, day: string): boolean {
  if (day < meeting.from || day > meeting.until) return false;
  if (meeting.skip.includes(day)) return false;
  return meeting.weekdays.includes(parseLocalDay(day).getDay());
}

/** One meeting on one day, with its start and end as instants. */
export interface MeetingOccurrence {
  course: Course;
  meeting: CourseMeeting;
  /** `YYYY-MM-DD` */
  day: string;
  startsAt: Date;
  endsAt: Date;
}

function occurrence(
  course: Course,
  meeting: CourseMeeting,
  day: string,
): MeetingOccurrence {
  const midnight = parseLocalDay(day);
  const at = (minutes: number) =>
    new Date(
      midnight.getFullYear(),
      midnight.getMonth(),
      midnight.getDate(),
      Math.floor(minutes / 60),
      minutes % 60,
    );
  return { course, meeting, day, startsAt: at(meeting.start), endsAt: at(meeting.end) };
}

/** Every meeting of every live course on `day`, in start order. */
export function meetingsOn(courses: readonly Course[], day: string): MeetingOccurrence[] {
  return courses
    .filter((course) => !course.archived)
    .flatMap((course) =>
      course.meetings
        .filter((meeting) => meetsOn(meeting, day))
        .map((meeting) => occurrence(course, meeting, day)),
    )
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * The meeting in progress at `now`, or starting within `NOW_LEAD_MINUTES`.
 * When two overlap, the one already under way wins over the one about to
 * start, and the earlier start wins among those in progress — the student is
 * more likely still in the first room than already in the second.
 */
export function currentMeeting(
  courses: readonly Course[],
  now: Date = new Date(),
  leadMinutes = NOW_LEAD_MINUTES,
): MeetingOccurrence | null {
  const time = now.getTime();
  const lead = leadMinutes * 60_000;
  const candidates = meetingsOn(courses, localDay(now)).filter(
    (entry) => entry.startsAt.getTime() - lead <= time && time < entry.endsAt.getTime(),
  );
  return (
    candidates.find((entry) => entry.startsAt.getTime() <= time) ?? candidates[0] ?? null
  );
}

/** `{meetingId}:{YYYY-MM-DD}` — what `Note.lectureKey` holds. */
export function lectureKey(meetingId: string, day: string): string {
  return `${meetingId}:${day}`;
}
