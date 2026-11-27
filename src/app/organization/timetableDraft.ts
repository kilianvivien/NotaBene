/**
 * A timetable row as the course editor holds it while it is being edited.
 *
 * A draft keeps its times as the `HH:MM` text an `<input type="time">`
 * produces, not as minutes, because WebKit lets a student clear the field — a
 * blank has to stay a blank the row can complain about, rather than snapping
 * back or becoming `NaN`.
 */
import {
  CourseMeetingSchema,
  MAX_COURSE_MEETINGS,
  type CourseMeeting,
} from '@/lib/schema';
import {
  createMeeting,
  minutesToTime,
  normalizeMeeting,
  parseLocalDay,
  repeatsWeekly,
  repeatWeekly,
  timeToMinutes,
} from '@/lib/timetable/meetings';
import { localDay } from '@/lib/utils/calendar';

/** `CourseSchema` refuses more; the Add button stops there instead. */
export const MAX_MEETINGS = MAX_COURSE_MEETINGS;

/** What a date input produces; the schema checks the month and day. */
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface MeetingDraft extends Omit<CourseMeeting, 'start' | 'end'> {
  start: string;
  end: string;
  /**
   * Repetition is held as a choice rather than read from `until > from`: a
   * repeating row whose last day is being retyped must not turn into a single
   * session — and hide the field being typed in — halfway through.
   */
  weekly: boolean;
}

export type MeetingProblem =
  'noDays' | 'date' | 'time' | 'endBeforeStart' | 'term' | 'untilBeforeFrom' | 'invalid';

export function toDraft(meeting: CourseMeeting): MeetingDraft {
  return {
    ...meeting,
    start: minutesToTime(meeting.start),
    end: minutesToTime(meeting.end),
    weekly: repeatsWeekly(meeting),
  };
}

export function newDraft(today: Date = new Date()): MeetingDraft {
  return toDraft(createMeeting(today));
}

/** Turn weekly repetition on or off. Switching it on starts the series on the
 * session's own weekday and gives it a semester; nothing is trimmed, so a
 * space typed in the title survives the click. */
export function setWeekly(draft: MeetingDraft, on: boolean): MeetingDraft {
  if (!on) return { ...draft, weekly: false, until: draft.from };
  if (draft.weekly || !DAY.test(draft.from)) return { ...draft, weekly: true };
  const { until } = repeatWeekly({ ...draft, start: 0, end: 1, until: draft.from }, true);
  return {
    ...draft,
    weekly: true,
    until,
    weekdays: [parseLocalDay(draft.from).getDay()],
  };
}

/** The day a draft is last held: its own date for a single session. Past
 * sessions are split off on this, so a series that began in September is not
 * "past" in November. */
export function lastDay(draft: MeetingDraft): string {
  return draft.weekly ? draft.until : draft.from;
}

/** By date, then start time — the order a student reads a timetable in. */
export function sortDrafts(drafts: readonly MeetingDraft[]): MeetingDraft[] {
  return [...drafts].sort(
    (a, b) => a.from.localeCompare(b.from) || a.start.localeCompare(b.start),
  );
}

export function today(): string {
  return localDay(new Date());
}

/**
 * The meeting a draft saves as, or the first thing wrong with it. The named
 * checks come first so the row can say something useful; the schema is the
 * final gate, so nothing the dialog lets through can be refused by the
 * command.
 */
export function checkMeeting(
  draft: MeetingDraft,
):
  { meeting: CourseMeeting; problem: null } | { meeting: null; problem: MeetingProblem } {
  const { weekly, ...fields } = draft;
  const start = timeToMinutes(fields.start);
  const end = timeToMinutes(fields.end);
  if (!DAY.test(fields.from)) return { meeting: null, problem: weekly ? 'term' : 'date' };
  if (start === null || end === null) return { meeting: null, problem: 'time' };
  if (end <= start) return { meeting: null, problem: 'endBeforeStart' };
  if (weekly) {
    if (fields.weekdays.length === 0) return { meeting: null, problem: 'noDays' };
    if (!DAY.test(fields.until)) return { meeting: null, problem: 'term' };
    // Ending on its first day would save a single session and quietly drop
    // the days ticked.
    if (fields.until <= fields.from) return { meeting: null, problem: 'untilBeforeFrom' };
  }
  // A single session's day is its date: `normalizeMeeting` derives the
  // weekday and drops skipped days from `from === until`.
  const parsed = CourseMeetingSchema.safeParse(
    normalizeMeeting({
      ...fields,
      start,
      end,
      until: weekly ? fields.until : fields.from,
    }),
  );
  return parsed.success
    ? { meeting: parsed.data, problem: null }
    : { meeting: null, problem: 'invalid' };
}
