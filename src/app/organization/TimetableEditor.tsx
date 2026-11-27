/**
 * The course editor's timetable: one line per session, opened to edit.
 *
 * A school's timetable is one dated event per session, so a course easily
 * holds a hundred of them; a full form per row would make the dialog a wall.
 * Each row is therefore a summary that opens in place, and the sessions
 * already over fold behind one line.
 *
 * `CourseDialog` owns the drafts and the save; this file only edits them and
 * says what is wrong with each (`timetableDraft.ts`).
 */
import { useMemo, useState } from 'react';
import { ChevronRight, ChevronUp, Plus, Repeat, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassButton, GlassIconButton, GlassSelect } from '@/components/glass';
import type { NoteTemplate } from '@/lib/schema';
import { parseLocalDay } from '@/lib/timetable/meetings';
import { firstDayOfWeek } from '@/lib/utils/calendar';
import { cn } from '@/lib/utils/cn';
import {
  checkMeeting,
  DAY,
  lastDay,
  MAX_MEETINGS,
  newDraft,
  setWeekly,
  sortDrafts,
  today,
  type MeetingDraft,
} from './timetableDraft';

const compactField =
  'h-7 min-w-0 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-1.5 text-[12px] text-nb-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]';

interface Weekday {
  day: number;
  narrow: string;
  short: string;
  long: string;
}

/** The week as the locale lays it out: narrow letters to show, full names to
 * announce — the letters repeat (T/T, S/S, M/M in French), so a toggle is
 * keyed and named by its day, never by its letter. */
function useWeekdays(locale: string): Weekday[] {
  return useMemo(() => {
    const narrow = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
    const short = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    const long = new Intl.DateTimeFormat(locale, { weekday: 'long' });
    const first = firstDayOfWeek(locale);
    return Array.from({ length: 7 }, (_, index) => {
      const day = (first + index) % 7;
      // 2024-01-07 was a Sunday, so day N is the 7th plus N.
      const date = new Date(2024, 0, 7 + day);
      return {
        day,
        narrow: narrow.format(date),
        short: short.format(date),
        long: long.format(date),
      };
    });
  }, [locale]);
}

export function TimetableEditor({
  meetings,
  onChange,
  templates,
}: {
  meetings: MeetingDraft[];
  onChange(next: MeetingDraft[]): void;
  /** The templates this course may start a note from: its own and the global
   * ones. A meeting keeps one it already names even if it is not among them. */
  templates: NoteTemplate[];
}) {
  const { t, i18n } = useTranslation();
  const weekdays = useWeekdays(i18n.language);
  const full = meetings.length >= MAX_MEETINGS;
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [showPast, setShowPast] = useState(false);

  // Rows are put in order when one closes or is added, never while a field is
  // being typed in: WebKit reports a date while its year is still half typed,
  // and a live sort would move the row out from under the cursor.
  const day = today();
  const rows = meetings.map((meeting, index) => {
    const { problem } = checkMeeting(meeting);
    const last = lastDay(meeting);
    return {
      meeting,
      index,
      // A row that cannot be saved stays open, or Confirm would be disabled
      // with nothing on screen to say why.
      open: opened.has(meeting.id) || problem !== null,
      past: DAY.test(last) && last < day,
    };
  });
  const pastCount = rows.filter((row) => row.past).length;

  const replace = (index: number, next: MeetingDraft) =>
    onChange(meetings.map((meeting, at) => (at === index ? next : meeting)));
  const setOpen = (id: string, open: boolean) =>
    setOpened((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <section
      aria-labelledby="nb-timetable-title"
      className="mt-5 border-t border-[var(--nb-divider)] pt-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id="nb-timetable-title" className="text-[12px] font-medium text-nb-text-2">
          {t('organization.timetable.title')}
        </h3>
        <GlassButton
          size="sm"
          variant="ghost"
          disabled={full}
          title={
            full ? t('organization.timetable.limit', { count: MAX_MEETINGS }) : undefined
          }
          onClick={() => {
            const draft = newDraft();
            onChange(sortDrafts([...meetings, draft]));
            setOpen(draft.id, true);
          }}
        >
          <Plus size={13} aria-hidden />
          {t('organization.timetable.add')}
        </GlassButton>
      </div>

      {meetings.length === 0 ? (
        <p className="mt-1.5 text-[12px] leading-snug text-nb-text-3">
          {t('organization.timetable.empty')}
        </p>
      ) : (
        <>
          {pastCount > 0 && (
            <button
              type="button"
              aria-expanded={showPast}
              onClick={() => setShowPast((value) => !value)}
              className="mt-1 flex items-center gap-1 rounded-nb-xs py-1 text-[11.5px] text-nb-text-3 hover:text-nb-text-2"
            >
              <ChevronRight
                size={12}
                aria-hidden
                className={cn(
                  'shrink-0 transition-transform duration-[var(--nb-t-fast)]',
                  showPast && 'rotate-90',
                )}
              />
              {t('organization.timetable.past', { count: pastCount })}
            </button>
          )}
          {/* Bounded, so a year of sessions does not push the lecture settings
              and the save error below the dialog's fold. */}
          <ul className="mt-1 max-h-[320px] divide-y divide-[var(--nb-divider)] overflow-y-auto">
            {rows
              .filter((row) => !row.past || showPast || row.open)
              .map(({ meeting, index, open }) =>
                open ? (
                  <MeetingEditor
                    key={meeting.id}
                    index={index}
                    meeting={meeting}
                    weekdays={weekdays}
                    templates={templates}
                    onChange={(next) => replace(index, next)}
                    onClose={() => {
                      setOpen(meeting.id, false);
                      onChange(sortDrafts(meetings));
                    }}
                    onRemove={() => {
                      setOpen(meeting.id, false);
                      onChange(meetings.filter((_, at) => at !== index));
                    }}
                  />
                ) : (
                  <MeetingSummary
                    key={meeting.id}
                    meeting={meeting}
                    weekdays={weekdays}
                    onOpen={() => setOpen(meeting.id, true)}
                  />
                ),
              )}
          </ul>
        </>
      )}
    </section>
  );
}

function useDayLabel() {
  const { i18n } = useTranslation();
  const year = new Date().getFullYear();
  return (day: string, withWeekday = false) => {
    const date = parseLocalDay(day);
    return date.toLocaleDateString(i18n.language, {
      ...(withWeekday ? { weekday: 'short' as const } : {}),
      day: 'numeric',
      month: 'short',
      // An academic year crosses January; only another year needs saying.
      ...(date.getFullYear() !== year ? { year: 'numeric' as const } : {}),
    });
  };
}

function MeetingSummary({
  meeting,
  weekdays,
  onOpen,
}: {
  meeting: MeetingDraft;
  weekdays: Weekday[];
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const dayLabel = useDayLabel();
  const when = meeting.weekly
    ? t('organization.timetable.weeklySummary', {
        days: weekdays
          .filter(({ day }) => meeting.weekdays.includes(day))
          .map(({ short }) => short)
          .join(', '),
        until: dayLabel(meeting.until),
      })
    : dayLabel(meeting.from, true);
  const what = [meeting.title?.trim(), meeting.location?.trim()].filter(Boolean);

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('organization.timetable.edit', {
          session: [when, `${meeting.start}–${meeting.end}`, ...what].join(', '),
        })}
        className="grid w-full grid-cols-[minmax(7rem,auto)_auto_minmax(0,1fr)] items-baseline gap-x-3 rounded-nb-xs px-1 py-1.5 text-left text-[12px] hover:bg-[var(--nb-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]"
      >
        <span className="flex items-center gap-1 text-nb-text-2">
          {meeting.weekly && (
            <Repeat size={11} aria-hidden className="shrink-0 text-nb-text-3" />
          )}
          {when}
        </span>
        <span className="tabular-nums text-nb-text-3">
          {meeting.start}–{meeting.end}
        </span>
        <span className="min-w-0 break-words">
          {meeting.title?.trim() && (
            <span className="text-nb-text">{meeting.title.trim()}</span>
          )}
          {meeting.title?.trim() && meeting.location?.trim() && (
            <span className="text-nb-text-3"> · </span>
          )}
          {meeting.location?.trim() && (
            <span className="text-nb-text-3">{meeting.location.trim()}</span>
          )}
        </span>
      </button>
    </li>
  );
}

function MeetingEditor({
  index,
  meeting,
  weekdays,
  templates,
  onChange,
  onClose,
  onRemove,
}: {
  index: number;
  meeting: MeetingDraft;
  weekdays: Weekday[];
  templates: NoteTemplate[];
  onChange(next: MeetingDraft): void;
  onClose(): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const dayLabel = useDayLabel();
  const [skipDay, setSkipDay] = useState('');
  const canSkip = DAY.test(skipDay) && !meeting.skip.includes(skipDay);
  const { problem } = checkMeeting(meeting);
  const errorId = `nb-meeting-error-${meeting.id}`;
  const update = (patch: Partial<MeetingDraft>) => onChange({ ...meeting, ...patch });
  const addSkip = () => {
    if (!canSkip) return;
    update({ skip: [...meeting.skip, skipDay].sort() });
    setSkipDay('');
  };

  return (
    <li
      aria-label={t('organization.timetable.meeting', { n: index + 1 })}
      aria-describedby={problem ? errorId : undefined}
      className="space-y-2 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input
          type="date"
          aria-label={t(
            meeting.weekly
              ? 'organization.timetable.from'
              : 'organization.timetable.date',
          )}
          className={`${compactField} w-[8.5rem]`}
          value={meeting.from}
          // A single session's last day is its day; moving one moves both.
          onChange={(event) =>
            update(
              meeting.weekly
                ? { from: event.target.value }
                : { from: event.target.value, until: event.target.value },
            )
          }
        />
        <div className="flex items-center gap-1 text-[12px] text-nb-text-3">
          <input
            type="time"
            aria-label={t('organization.timetable.start')}
            className={`${compactField} w-[5.5rem]`}
            value={meeting.start}
            onChange={(event) => update({ start: event.target.value })}
          />
          <span aria-hidden>–</span>
          <input
            type="time"
            aria-label={t('organization.timetable.end')}
            className={`${compactField} w-[5.5rem]`}
            value={meeting.end}
            onChange={(event) => update({ end: event.target.value })}
          />
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          {problem === null && (
            <GlassIconButton
              label={t('organization.timetable.close')}
              className="size-7"
              onClick={onClose}
            >
              <ChevronUp size={14} aria-hidden />
            </GlassIconButton>
          )}
          <GlassIconButton
            label={t('organization.timetable.remove')}
            className="size-7 hover:text-[var(--nb-danger)]"
            onClick={onRemove}
          >
            <Trash2 size={13} aria-hidden />
          </GlassIconButton>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)] gap-2">
        <input
          aria-label={t('organization.timetable.sessionTitle')}
          placeholder={t('organization.timetable.sessionTitlePlaceholder')}
          className={`${compactField} w-full`}
          maxLength={300}
          value={meeting.title ?? ''}
          onChange={(event) => update({ title: event.target.value })}
        />
        <input
          aria-label={t('organization.timetable.location')}
          placeholder={t('organization.timetable.locationPlaceholder')}
          className={`${compactField} w-full`}
          maxLength={200}
          value={meeting.location ?? ''}
          onChange={(event) => update({ location: event.target.value })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-nb-text-3">
        <label className="flex items-center gap-1.5 text-[12px] text-nb-text-2">
          <input
            type="checkbox"
            className="size-3.5 accent-[var(--nb-accent)]"
            checked={meeting.weekly}
            disabled={!DAY.test(meeting.from)}
            onChange={(event) => onChange(setWeekly(meeting, event.target.checked))}
          />
          {t('organization.timetable.repeatWeekly')}
        </label>
        <TemplateChoice
          value={meeting.templateId}
          templates={templates}
          onChange={(templateId) => update({ templateId })}
        />
      </div>

      {meeting.weekly && (
        <div className="space-y-2 rounded-nb-xs bg-[var(--nb-inset-surface)] px-2 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div
              role="group"
              aria-label={t('organization.timetable.days')}
              className="flex gap-0.5"
            >
              {weekdays.map(({ day, narrow, long }) => {
                const pressed = meeting.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-label={long}
                    title={long}
                    aria-pressed={pressed}
                    onClick={() =>
                      update({
                        weekdays: pressed
                          ? meeting.weekdays.filter((candidate) => candidate !== day)
                          : [...meeting.weekdays, day],
                      })
                    }
                    className="grid size-6 place-items-center rounded-nb-xs border border-[var(--nb-control-border)] text-[11px] font-medium text-nb-text-2 hover:bg-[var(--nb-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)] aria-pressed:border-[var(--nb-accent)] aria-pressed:bg-[var(--nb-accent-soft)] aria-pressed:text-[var(--nb-accent)]"
                  >
                    {narrow}
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-1 text-[11px] text-nb-text-3">
              {t('organization.timetable.until')}
              <input
                type="date"
                className={`${compactField} w-[8.5rem]`}
                min={DAY.test(meeting.from) ? meeting.from : undefined}
                value={meeting.until}
                onChange={(event) => update({ until: event.target.value })}
              />
            </label>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-nb-text-3">
            <span>{t('organization.timetable.skipped')}</span>
            {meeting.skip.map((day) => (
              <span
                key={day}
                className="inline-flex items-center gap-0.5 rounded-full bg-[var(--nb-active)] py-0.5 pl-2 pr-0.5 text-[11px] text-nb-text-2"
              >
                {dayLabel(day)}
                <button
                  type="button"
                  aria-label={t('organization.timetable.unskip', { day: dayLabel(day) })}
                  title={t('organization.timetable.unskip', { day: dayLabel(day) })}
                  className="grid size-4 place-items-center rounded-full hover:bg-[var(--nb-hover)] hover:text-nb-text"
                  onClick={() =>
                    update({
                      skip: meeting.skip.filter((candidate) => candidate !== day),
                    })
                  }
                >
                  <X size={10} aria-hidden />
                </button>
              </span>
            ))}
            <input
              type="date"
              aria-label={t('organization.timetable.skipDay')}
              className={`${compactField} h-6 w-[8.5rem]`}
              min={DAY.test(meeting.from) ? meeting.from : undefined}
              max={DAY.test(meeting.until) ? meeting.until : undefined}
              value={skipDay}
              onChange={(event) => setSkipDay(event.target.value)}
              onKeyDown={(event) => {
                // Return here means "skip this day", not "save the course".
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addSkip();
              }}
            />
            {/* An explicit add rather than adding on change: WebKit reports a
                date while its year is still being typed. */}
            <GlassIconButton
              label={t('organization.timetable.addSkip')}
              className="size-6"
              disabled={!canSkip}
              onClick={addSkip}
            >
              <Plus size={12} aria-hidden />
            </GlassIconButton>
          </div>
        </div>
      )}

      {problem && (
        <p id={errorId} role="alert" className="text-[11px] text-[var(--nb-danger)]">
          {t(`organization.timetable.error.${problem}`)}
        </p>
      )}
    </li>
  );
}

function TemplateChoice({
  value,
  templates,
  onChange,
}: {
  value: string | null;
  templates: NoteTemplate[];
  onChange(next: string | null): void;
}) {
  const { t } = useTranslation();
  // A meeting whose template was deleted keeps naming it until the student
  // picks another: dropping it silently would change which template the next
  // lecture starts from without anyone choosing that.
  const missing = value !== null && !templates.some((template) => template.id === value);
  if (templates.length === 0 && !missing) return null;
  return (
    <span className="flex items-center gap-1">
      {t('organization.timetable.template')}
      <GlassSelect
        size="sm"
        label={t('organization.timetable.template')}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{t('organization.timetable.courseDefault')}</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
        {missing && (
          <option value={value}>{t('organization.timetable.missingTemplate')}</option>
        )}
      </GlassSelect>
    </span>
  );
}
