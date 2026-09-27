/**
 * Tasks as an iCalendar file, for Apple Calendar and everything else.
 *
 * Decisions, each made with the feature (plan §19):
 *
 * - **`VEVENT`, not `VTODO`.** Apple Calendar shows events and ignores to-dos
 *   in an imported file, and Reminders does not import `.ics` at all. A task
 *   with a due time becomes a short event at that time; one due on a day (local
 *   midnight, which is how NotaBene stores "no time") becomes an all-day event.
 * - **Stable identity.** `UID:task-{id}@notabene`, with `SEQUENCE` and
 *   `DTSTAMP` from `updatedAt`, so importing a fresh export into Calendar
 *   updates the events it made last time instead of adding a second set.
 * - **Floating local time** — no `Z`, no `TZID` — because the recurrence engine
 *   runs in local time on purpose: an 08:00 task stays at 08:00 across a clock
 *   change, in Calendar too.
 * - **The three recurrence presets map onto `RRULE` exactly**, including the
 *   monthly anchor: "the 31st, or the month's last day" is
 *   `BYMONTHDAY=28,29,30,31;BYSETPOS=-1`, which is what `nextOccurrence` does.
 *
 * No dependency: the format is line folding, escaping and CRLF, and a library
 * would be a larger surface than the serializer it replaces.
 */
import type { Recurrence, Task } from '@/lib/schema';

const CRLF = '\r\n';
/** How long a timed task is on the calendar. A deadline is a moment, but a
 * zero-length event is easy to miss in a week view. */
const EVENT_MINUTES = 30;
/** `SEQUENCE` must grow with each revision; seconds since this epoch do, and
 * stay small enough for every client to read as an integer. */
const SEQUENCE_EPOCH = Date.UTC(2024, 0, 1);

/** `,` `;` `\` and newlines, as RFC 5545 §3.3.11 escapes them. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n?|\n/g, '\\n');
}

/**
 * Fold a content line at 75 octets, continuing with a space (§3.1).
 *
 * Octets, not characters: "Théorème" is longer in UTF-8 than it looks, and a
 * fold must never split a multi-byte character.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  // The first line may hold 75 octets; continuations 74, after their space.
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      out.push(current);
      current = char;
      bytes = size;
      limit = 74;
    } else {
      current += char;
      bytes += size;
    }
  }
  out.push(current);
  return out.join(`${CRLF} `);
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** Floating local date-time: `20260131T090000`. */
function localDateTime(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function localDate(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** UTC, for `DTSTAMP`, which the RFC requires in UTC. */
function utcDateTime(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** NotaBene's "a day, no time" is local midnight — the date field shows no
 * time for exactly that instant. */
export function isAllDay(iso: string): boolean {
  const date = new Date(iso);
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export function recurrenceToRrule(rule: Recurrence, dueAt: Date): string {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === 'weekly' && rule.weekdays.length) {
    const days = [...new Set(rule.weekdays)].sort((a, b) => a - b);
    parts.push(`BYDAY=${days.map((day) => WEEKDAYS[day]).join(',')}`);
  }
  if (rule.freq === 'monthly') {
    const day = rule.monthDay ?? dueAt.getDate();
    if (day > 28) {
      // "The 30th, or the last day of a shorter month": the last of the listed
      // days that the month actually has.
      const days = Array.from({ length: day - 27 }, (_, index) => 28 + index);
      parts.push(`BYMONTHDAY=${days.join(',')}`, 'BYSETPOS=-1');
    } else {
      parts.push(`BYMONTHDAY=${day}`);
    }
  }
  return parts.join(';');
}

/** `-PT15M`, `-P1DT2H`, `PT0S` — a trigger relative to the event's start, so
 * the alert moves with the event when Calendar moves it. */
export function durationBefore(milliseconds: number): string {
  const sign = milliseconds > 0 ? '-' : '';
  let seconds = Math.round(Math.abs(milliseconds) / 1000);
  if (!seconds) return 'PT0S';
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const time = [
    hours ? `${hours}H` : '',
    minutes ? `${minutes}M` : '',
    seconds ? `${seconds}S` : '',
  ].join('');
  return `${sign}P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

export interface CalendarExportOptions {
  /** Titles of parents, so a subtask reads "Essay — Outline" in Calendar,
   * where it has no parent to sit under. */
  parentTitles?: ReadonlyMap<string, string>;
  courseNames?: ReadonlyMap<string, string>;
  calendarName?: string;
  appVersion?: string;
}

export interface CalendarExport {
  ics: string;
  exported: number;
  /** Tasks left out because a calendar has nowhere to put them. */
  withoutDueDate: number;
}

export function tasksToIcs(
  tasks: readonly Task[],
  options: CalendarExportOptions = {},
): CalendarExport {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//NotaBene//NotaBene${options.appVersion ? ` ${options.appVersion}` : ''}//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  if (options.calendarName)
    lines.push(`X-WR-CALNAME:${escapeText(options.calendarName)}`);

  let exported = 0;
  let withoutDueDate = 0;
  for (const task of tasks) {
    if (!task.dueAt) {
      withoutDueDate += 1;
      continue;
    }
    const due = new Date(task.dueAt);
    if (Number.isNaN(due.getTime())) {
      withoutDueDate += 1;
      continue;
    }
    const updated = new Date(task.updatedAt);
    const parent = task.parentId ? options.parentTitles?.get(task.parentId) : undefined;
    const title = parent ? `${parent} — ${task.title}` : task.title;
    const allDay = isAllDay(task.dueAt);

    lines.push('BEGIN:VEVENT', `UID:task-${task.id}@notabene`);
    lines.push(`DTSTAMP:${utcDateTime(updated)}`);
    lines.push(
      `SEQUENCE:${Math.max(0, Math.floor((updated.getTime() - SEQUENCE_EPOCH) / 1000))}`,
    );
    if (allDay) {
      const next = new Date(due);
      next.setDate(next.getDate() + 1);
      lines.push(
        `DTSTART;VALUE=DATE:${localDate(due)}`,
        `DTEND;VALUE=DATE:${localDate(next)}`,
      );
    } else {
      lines.push(`DTSTART:${localDateTime(due)}`, `DURATION:PT${EVENT_MINUTES}M`);
    }
    lines.push(`SUMMARY:${escapeText(title)}`);
    if (task.details.trim()) lines.push(`DESCRIPTION:${escapeText(task.details)}`);
    const course = task.courseId ? options.courseNames?.get(task.courseId) : undefined;
    if (course) lines.push(`CATEGORIES:${escapeText(course)}`);
    if (task.recurrence && !task.parentId) {
      lines.push(`RRULE:${recurrenceToRrule(task.recurrence, due)}`);
    }
    if (task.remindAt) {
      const offset = due.getTime() - new Date(task.remindAt).getTime();
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(title)}`,
        `TRIGGER:${durationBefore(offset)}`,
        'END:VALARM',
      );
    }
    lines.push('END:VEVENT');
    exported += 1;
  }
  lines.push('END:VCALENDAR');

  return {
    ics: lines.map(foldLine).join(CRLF) + CRLF,
    exported,
    withoutDueDate,
  };
}
