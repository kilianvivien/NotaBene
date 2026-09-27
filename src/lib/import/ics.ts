/**
 * Reading an iCalendar file into tasks — strictly, and bounded.
 *
 * An `.ics` is untrusted text from anywhere (§11): a university's Moodle, a
 * shared class calendar, a file someone emailed. So the size and the event
 * count are checked before anything is parsed, only `VEVENT` and `VTODO` are
 * read, every property is length-capped, and nothing is approximated
 * silently: a rule that does not fit NotaBene's three recurrence presets
 * imports as one occurrence and says so.
 *
 * Two halves, like the note importers: `parseIcs` reads, and the pure
 * `planCalendarImport` decides what each event would become — new, an update
 * to a task imported before, or unchanged — against the tasks already here.
 */
import {
  anchorRecurrence,
  nextOccurrence,
  nextOccurrenceAfter,
} from '@/lib/tasks/recurrence';
import type { ImportWarning, Recurrence, Task } from '@/lib/schema';

/** A term's worth of calendars is well under this. */
export const MAX_ICS_BYTES = 5 * 1024 * 1024;
export const MAX_ICS_EVENTS = 5_000;
const MAX_TEXT = 10_000;

export class IcsRefusal extends Error {
  constructor(readonly code: 'tooLarge' | 'tooManyEvents' | 'notCalendar') {
    super(code);
    this.name = 'IcsRefusal';
  }
}

export interface IcsEvent {
  kind: 'event' | 'todo';
  uid: string;
  summary: string;
  description: string;
  /** ISO instant. For an all-day event, local midnight of its day. */
  start: string;
  allDay: boolean;
  /** Minutes between start and end; `null` when the event states no end. */
  durationMinutes: number | null;
  rrule: string | null;
  /** The series has exceptions (`EXDATE`/`RDATE`) NotaBene cannot hold. */
  exceptions: boolean;
  /** An override of one occurrence of another event's series. */
  overridesOccurrence: boolean;
  /** How long before `start` the first alarm fires, in milliseconds. */
  alarmBeforeMs: number | null;
  completed: boolean;
}

export interface IcsParse {
  events: IcsEvent[];
  /** Components that are not events or to-dos, and events without a date. */
  skipped: { summary: string; reason: 'noDate' | 'unsupported' }[];
  warnings: ImportWarning[];
}

function warn(warnings: ImportWarning[], code: string): void {
  const existing = warnings.find((warning) => warning.code === code);
  if (existing) existing.count += 1;
  else warnings.push({ code, count: 1 });
}

/** §3.3.11 in reverse. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, char: string) =>
    char === 'n' || char === 'N' ? '\n' : char,
  );
}

interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** `DTSTART;TZID="Europe/Paris";VALUE=DATE-TIME:20260131T090000` */
function parseLine(line: string): ContentLine | null {
  let inQuotes = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ':' && !inQuotes) {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return null;
  const [rawName, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const equals = param.indexOf('=');
    if (equals > 0) {
      params[param.slice(0, equals).toUpperCase()] = param
        .slice(equals + 1)
        .replace(/^"|"$/g, '');
    }
  }
  return { name: rawName!.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** The offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - instant;
}

/**
 * An iCalendar date or date-time, as an ISO instant.
 *
 * `Z` is UTC; a `TZID` is converted through `Intl`; a bare date-time is
 * floating and read as local time; a date alone is all-day, at local midnight
 * — which is how NotaBene stores a due day with no time.
 */
export function parseIcsDate(
  value: string,
  params: Record<string, string>,
  warnings: ImportWarning[] = [],
): { iso: string; allDay: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, utc] = match;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);
  if (h === undefined || params.VALUE === 'DATE') {
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime())
      ? null
      : { iso: date.toISOString(), allDay: true };
  }
  const fields = [year, month, day, Number(h), Number(mi), Number(s)] as const;
  if (utc) return { iso: new Date(Date.UTC(...fields)).toISOString(), allDay: false };
  if (params.TZID) {
    try {
      const wall = Date.UTC(...fields);
      // Two passes, so a wall time near a clock change lands on the offset in
      // force at that moment rather than the one a few hours earlier.
      let instant = wall - zoneOffset(wall, params.TZID);
      instant = wall - zoneOffset(instant, params.TZID);
      return { iso: new Date(instant).toISOString(), allDay: false };
    } catch {
      // A Windows zone name such as "Romance Standard Time" is not one `Intl`
      // knows. Local time is the nearest honest reading, and it is said.
      warn(warnings, 'unknownTimezone');
    }
  }
  return { iso: new Date(...fields).toISOString(), allDay: false };
}

/** `P1W`, `-PT15M`, `P1DT2H30M`, in milliseconds. */
export function parseIcsDuration(value: string): number | null {
  const match =
    /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      value.trim(),
    );
  if (!match || value.trim() === 'P' || value.trim().endsWith('T')) return null;
  const [, sign, w, d, h, m, s] = match;
  const total =
    (Number(w ?? 0) * 7 * 86_400 +
      Number(d ?? 0) * 86_400 +
      Number(h ?? 0) * 3_600 +
      Number(m ?? 0) * 60 +
      Number(s ?? 0)) *
    1000;
  return sign === '-' ? -total : total;
}

export function parseIcs(text: string): IcsParse {
  if (new TextEncoder().encode(text).length > MAX_ICS_BYTES)
    throw new IcsRefusal('tooLarge');
  // Unfold before anything else: a folded line is one property (§3.1).
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  if (!lines.some((line) => line.trim().toUpperCase() === 'BEGIN:VCALENDAR')) {
    throw new IcsRefusal('notCalendar');
  }
  const componentCount = lines.filter((line) =>
    /^BEGIN:(VEVENT|VTODO)\s*$/i.test(line),
  ).length;
  if (componentCount > MAX_ICS_EVENTS) throw new IcsRefusal('tooManyEvents');

  const events: IcsEvent[] = [];
  const skipped: IcsParse['skipped'] = [];
  const warnings: ImportWarning[] = [];

  let stack: string[] = [];
  let props: ContentLine[] = [];
  let alarm: ContentLine[] | null = null;
  let alarms: ContentLine[][] = [];

  const finish = (kind: 'event' | 'todo') => {
    const first = (name: string) => props.find((prop) => prop.name === name);
    const text = (name: string, max = MAX_TEXT) =>
      unescapeText(first(name)?.value ?? '')
        .slice(0, max)
        .trim();
    const summary = text('SUMMARY', 500);
    const dateProp =
      kind === 'todo' ? (first('DUE') ?? first('DTSTART')) : first('DTSTART');
    const start = dateProp
      ? parseIcsDate(dateProp.value, dateProp.params, warnings)
      : null;
    if (!start) {
      skipped.push({ summary, reason: 'noDate' });
      return;
    }

    let durationMinutes: number | null = null;
    const endProp = first(kind === 'todo' ? 'DTSTART' : 'DTEND');
    if (kind === 'event' && endProp) {
      const end = parseIcsDate(endProp.value, endProp.params, warnings);
      if (end) durationMinutes = (Date.parse(end.iso) - Date.parse(start.iso)) / 60_000;
    } else if (first('DURATION')) {
      const duration = parseIcsDuration(first('DURATION')!.value);
      if (duration !== null) durationMinutes = duration / 60_000;
    }

    let alarmBeforeMs: number | null = null;
    for (const entries of alarms) {
      const trigger = entries.find((prop) => prop.name === 'TRIGGER');
      if (!trigger) continue;
      if (trigger.params.VALUE === 'DATE-TIME') {
        const at = parseIcsDate(trigger.value, trigger.params, warnings);
        if (at) alarmBeforeMs = Date.parse(start.iso) - Date.parse(at.iso);
      } else {
        const offset = parseIcsDuration(trigger.value);
        if (offset !== null) {
          const fromEnd =
            trigger.params.RELATED === 'END' && durationMinutes
              ? durationMinutes * 60_000
              : 0;
          alarmBeforeMs = -(offset + fromEnd);
        }
      }
      if (alarmBeforeMs !== null) break;
    }

    const uid = text('UID', 500) || `${summary}|${start.iso}`;
    const status = (first('STATUS')?.value ?? '').toUpperCase();
    events.push({
      kind,
      uid,
      summary,
      description: text('DESCRIPTION'),
      start: start.iso,
      allDay: start.allDay,
      durationMinutes,
      rrule: first('RRULE')?.value.trim() ?? null,
      exceptions: props.some((prop) => prop.name === 'EXDATE' || prop.name === 'RDATE'),
      overridesOccurrence: Boolean(first('RECURRENCE-ID')),
      alarmBeforeMs,
      completed:
        kind === 'todo' && (status === 'COMPLETED' || Boolean(first('COMPLETED'))),
    });
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (parsed.name === 'BEGIN') {
      const component = parsed.value.trim().toUpperCase();
      stack.push(component);
      if (component === 'VEVENT' || component === 'VTODO') {
        props = [];
        alarms = [];
      } else if (component === 'VALARM') {
        alarm = [];
      } else if (
        !['VCALENDAR', 'VTIMEZONE', 'STANDARD', 'DAYLIGHT'].includes(component) &&
        stack.length === 2
      ) {
        skipped.push({ summary: component, reason: 'unsupported' });
      }
      continue;
    }
    if (parsed.name === 'END') {
      const component = stack.pop();
      if (component === 'VALARM' && alarm) {
        alarms.push(alarm);
        alarm = null;
      } else if (component === 'VEVENT') {
        finish('event');
      } else if (component === 'VTODO') {
        finish('todo');
      }
      if (component !== parsed.value.trim().toUpperCase()) stack = [];
      continue;
    }
    const current = stack[stack.length - 1];
    if (current === 'VALARM' && alarm) alarm.push(parsed);
    else if (current === 'VEVENT' || current === 'VTODO') props.push(parsed);
  }

  return { events, skipped, warnings };
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

const WEEKDAY_CODES: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export interface MappedRule {
  /** The rule as a NotaBene preset, when its shape fits one. */
  recurrence: Recurrence | null;
  /**
   * `exact`: it repeats in NotaBene exactly as in the calendar.
   * `simplified`: the shape fits, but the series ends or has exceptions, which
   * a single rolling task cannot hold — it imports as its next occurrence.
   * `unsupported`: the shape does not fit; it imports as its first date.
   */
  fidelity: 'exact' | 'simplified' | 'unsupported';
  until: string | null;
  count: number | null;
}

export function mapRrule(rrule: string, start: string): MappedRule {
  const fields = new Map<string, string>();
  for (const part of rrule.split(';')) {
    const [key, value] = part.split('=');
    if (key && value !== undefined) fields.set(key.toUpperCase(), value.toUpperCase());
  }
  const unsupported: MappedRule = {
    recurrence: null,
    fidelity: 'unsupported',
    until: null,
    count: null,
  };
  const freq = fields.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return unsupported;

  const interval = Number(fields.get('INTERVAL') ?? '1');
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return unsupported;

  const recurrence: Recurrence = {
    freq: freq.toLowerCase() as Recurrence['freq'],
    interval,
    weekdays: [],
    monthDay: null,
  };

  const known = new Set([
    'FREQ',
    'INTERVAL',
    'BYDAY',
    'BYMONTHDAY',
    'BYSETPOS',
    'COUNT',
    'UNTIL',
    'WKST',
  ]);
  if ([...fields.keys()].some((key) => !known.has(key))) return unsupported;

  const byDay = fields.get('BYDAY');
  if (byDay) {
    if (freq !== 'WEEKLY') return unsupported;
    const days = byDay.split(',').map((code) => WEEKDAY_CODES[code]);
    // `1MO` — "the first Monday" — has a numeric prefix and no preset.
    if (days.some((day) => day === undefined)) return unsupported;
    recurrence.weekdays = [...new Set(days as number[])].sort((a, b) => a - b);
  }

  const byMonthDay = fields.get('BYMONTHDAY');
  const bySetPos = fields.get('BYSETPOS');
  if (byMonthDay) {
    if (freq !== 'MONTHLY') return unsupported;
    const days = byMonthDay.split(',').map(Number);
    if (days.length === 1 && days[0]! >= 1 && days[0]! <= 31 && !bySetPos) {
      recurrence.monthDay = days[0]!;
    } else if (
      // What NotaBene exports for "the 30th, or the last day of a shorter
      // month": 28,29,30 with BYSETPOS=-1.
      bySetPos === '-1' &&
      days.length >= 2 &&
      days.every((day, index) => day === 28 + index) &&
      days[days.length - 1]! <= 31
    ) {
      recurrence.monthDay = days[days.length - 1]!;
    } else {
      return unsupported;
    }
  } else if (bySetPos) {
    return unsupported;
  }

  const anchored = anchorRecurrence(recurrence, start) ?? recurrence;
  const untilValue = fields.get('UNTIL');
  const until = untilValue ? (parseIcsDate(untilValue, {})?.iso ?? null) : null;
  const count = fields.has('COUNT') ? Number(fields.get('COUNT')) : null;
  return {
    recurrence: anchored,
    fidelity: until || count ? 'simplified' : 'exact',
    until,
    count: count !== null && Number.isFinite(count) ? count : null,
  };
}

/** The first occurrence of a finite series at or after `now`, or `null` when
 * the series has already ended. Bounded, because a hostile file could ask for
 * a daily rule from the year 1900. */
function nextInFiniteSeries(
  start: string,
  mapped: MappedRule,
  now: string,
): string | null {
  if (!mapped.recurrence) return null;
  let candidate = start;
  for (let index = 0; index < 5_000; index += 1) {
    if (mapped.count !== null && index >= mapped.count) return null;
    if (mapped.until && candidate > mapped.until) return null;
    if (candidate >= now) return candidate;
    candidate = nextOccurrence(candidate, mapped.recurrence);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** What a deadline looks like in a calendar, as opposed to a class meeting:
 * a to-do, an all-day entry, a zero-length moment, or a title that says so.
 * Moodle writes "… is due" at the deadline with no duration; Canvas makes
 * assignments all-day. A timetable is timed, recurring, and an hour long. */
const DEADLINE_WORDS =
  /\b(due|deadline|assignment|homework|submission|submit|quiz|exam|test|closes|devoir|rendu|à rendre|échéance|remise|examen|partiel|contrôle|dm)\b/i;

export function looksLikeDeadline(event: IcsEvent): boolean {
  return (
    event.kind === 'todo' ||
    event.allDay ||
    event.durationMinutes === null ||
    event.durationMinutes <= 5 ||
    DEADLINE_WORDS.test(event.summary)
  );
}

export interface PlannedCalendarTask {
  event: IcsEvent;
  importKey: string;
  /** The task this event updates, when it was imported (or exported) before. */
  existingId: string | null;
  title: string;
  details: string;
  dueAt: string;
  remindAt: string | null;
  recurrence: Recurrence | null;
  fidelity: MappedRule['fidelity'] | 'single';
  deadline: boolean;
  /** Its date is before today. */
  past: boolean;
  status: 'new' | 'changed' | 'unchanged';
}

export interface CalendarPlan {
  tasks: PlannedCalendarTask[];
  skipped: IcsParse['skipped'];
  warnings: ImportWarning[];
  /** Occurrence overrides, which a single rolling task has nowhere to put. */
  overrides: number;
}

/** `task-{id}@notabene` — a UID NotaBene wrote itself, mapping straight back. */
const OWN_UID = /^task-(.+)@notabene$/;

function sameRecurrence(a: Recurrence | null, b: Recurrence | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function planCalendarImport(
  parse: IcsParse,
  existing: readonly Task[],
  now: string = new Date().toISOString(),
): CalendarPlan {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.toISOString();

  const byKey = new Map<string, Task>();
  const byId = new Map<string, Task>();
  for (const task of existing) {
    byId.set(task.id, task);
    if (task.importKey && !task.trashedAt && !byKey.has(task.importKey))
      byKey.set(task.importKey, task);
  }

  const tasks: PlannedCalendarTask[] = [];
  let overrides = 0;
  const seen = new Set<string>();
  for (const event of parse.events) {
    if (event.overridesOccurrence) {
      overrides += 1;
      continue;
    }
    // One task per UID; a calendar that repeats one is describing one thing.
    if (seen.has(event.uid)) continue;
    seen.add(event.uid);

    let dueAt = event.start;
    let recurrence: Recurrence | null = null;
    let fidelity: PlannedCalendarTask['fidelity'] = 'single';
    if (event.rrule) {
      const mapped = mapRrule(event.rrule, event.start);
      if (mapped.fidelity === 'exact' && !event.exceptions && mapped.recurrence) {
        recurrence = mapped.recurrence;
        fidelity = 'exact';
        // The task stands for the series, so it is due on the next occurrence.
        if (dueAt < today) dueAt = nextOccurrenceAfter(dueAt, recurrence, today);
      } else if (mapped.recurrence) {
        fidelity = 'simplified';
        dueAt = nextInFiniteSeries(event.start, mapped, today) ?? event.start;
      } else {
        fidelity = 'unsupported';
      }
    }

    const ownId = OWN_UID.exec(event.uid)?.[1];
    const importKey = `ics:${event.uid}`;
    const match = (ownId ? byId.get(ownId) : undefined) ?? byKey.get(importKey) ?? null;
    const title = event.summary.trim().slice(0, 500) || 'Untitled';
    const details = event.description.slice(0, MAX_TEXT);
    const remindAt =
      event.alarmBeforeMs !== null
        ? new Date(Date.parse(dueAt) - event.alarmBeforeMs).toISOString()
        : null;

    let status: PlannedCalendarTask['status'] = 'new';
    if (match) {
      status =
        match.title === title &&
        match.details === details &&
        match.dueAt === dueAt &&
        match.remindAt === remindAt &&
        sameRecurrence(match.recurrence, recurrence)
          ? 'unchanged'
          : 'changed';
    }

    tasks.push({
      event,
      importKey,
      existingId: match?.id ?? null,
      title,
      details,
      dueAt,
      remindAt,
      recurrence,
      fidelity,
      deadline: looksLikeDeadline(event),
      past: dueAt < today,
      status,
    });
  }

  tasks.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return { tasks, skipped: parse.skipped, warnings: parse.warnings, overrides };
}

export interface CalendarFilter {
  /** Deadline-looking events only (the default), or everything. */
  which: 'deadlines' | 'all';
  includePast: boolean;
}

/** Which planned tasks the student's filter keeps. Unchanged ones are kept in
 * the count but never written. */
export function selectCalendarTasks(
  plan: CalendarPlan,
  filter: CalendarFilter,
): PlannedCalendarTask[] {
  return plan.tasks.filter(
    (task) =>
      (filter.which === 'all' || task.deadline || task.existingId !== null) &&
      (filter.includePast || !task.past || task.recurrence !== null),
  );
}
