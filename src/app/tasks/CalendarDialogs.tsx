/**
 * Tasks to and from a calendar file (plan §19).
 *
 * Export says, before writing, how many tasks go and how many cannot — a task
 * with no due date has nowhere to be on a calendar. Import shows what it
 * would write and defaults to what looks like a deadline, because a
 * university timetable is mostly class meetings, and those are not tasks —
 * they become the courses' timetables instead, one group per category.
 */
import { CalendarClock, CalendarDays, CalendarRange, ListChecks } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChoiceGroup,
  Dialog,
  FieldNote,
  FieldRow,
  FieldToggle,
  GlassButton,
  GlassSelect,
  type ChoiceOption,
} from '@/components/glass';
import {
  applyCalendarImportCommand,
  applyTimetableImportCommand,
  calendarExportTasks,
  exportCalendarCommand,
  readCalendarCommand,
  type CalendarImportSummary,
  type TimetableImportSummary,
} from '@/lib/commands';
import {
  selectCalendarTasks,
  type CalendarFilter,
  type CalendarPlan,
  type PlannedCalendarTask,
} from '@/lib/import/ics';
import type { GroupChoice, TimetableGroup, TimetablePlan } from '@/lib/import/timetable';
import type { Course } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';

const LIST_LIMIT = 200;

type ExportScope = 'all' | 'course';

export function CalendarExportDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.calendarExportOpen);
  const setOpen = useUiStore((state) => state.setCalendarExportOpen);
  const view = useUiStore((state) => state.view);
  const tasks = useLibraryStore((state) => state.tasks);
  const courses = useLibraryStore((state) => state.courses);

  const viewCourse = view.kind === 'tasks' ? view.courseId : undefined;
  const [scope, setScope] = useState<ExportScope>(viewCourse ? 'course' : 'all');
  const [courseId, setCourseId] = useState(viewCourse ?? courses[0]?.id ?? '');
  const [includeDone, setIncludeDone] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'danger' | 'notice';
    text: string;
  } | null>(null);

  const chosen = calendarExportTasks(tasks, {
    courseId: scope === 'course' ? courseId : undefined,
    includeDone,
  });

  function close() {
    if (working) return;
    setMessage(null);
    setOpen(false);
  }

  async function run() {
    setWorking(true);
    setMessage(null);
    const result = await exportCalendarCommand({
      courseId: scope === 'course' ? courseId : undefined,
      includeDone,
    });
    setWorking(false);
    if (!result.ok) {
      if (result.code !== 'cancelled')
        setMessage({ tone: 'danger', text: t('calendar.exportFailed') });
      return;
    }
    setMessage({
      tone: 'notice',
      text: t('calendar.exported', { count: result.value.exported }),
    });
  }

  const options: ChoiceOption<ExportScope>[] = [
    {
      value: 'all',
      title: t('calendar.scope.all'),
      description: t('calendar.scopeHint.all'),
      icon: CalendarRange,
    },
    {
      value: 'course',
      title: t('calendar.scope.course'),
      description: t('calendar.scopeHint.course'),
      icon: CalendarDays,
      disabled: !courses.length,
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={close}
      closeDisabled={working}
      title={t('calendar.exportTitle')}
      description={t('calendar.exportDescription')}
      size="md"
      footer={
        <>
          <GlassButton
            size="sm"
            variant="accent"
            disabled={working || chosen.tasks.length === 0}
            onClick={() => void run()}
          >
            {t('calendar.exportButton', { count: chosen.tasks.length })}
          </GlassButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ChoiceGroup<ExportScope>
          label={t('calendar.scopeLabel')}
          value={scope}
          onChange={setScope}
          options={options}
        />
        {scope === 'course' && (
          <FieldRow label={t('calendar.course')}>
            <GlassSelect
              label={t('calendar.course')}
              size="sm"
              value={courseId}
              onChange={(event) => setCourseId(event.target.value)}
            >
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}
                </option>
              ))}
            </GlassSelect>
          </FieldRow>
        )}
        <FieldRow label={t('calendar.includeDone')} align="end">
          <FieldToggle
            label={t('calendar.includeDone')}
            checked={includeDone}
            onChange={setIncludeDone}
          />
        </FieldRow>
        {chosen.withoutDueDate > 0 && (
          <FieldNote>
            {t('calendar.withoutDueDate', { count: chosen.withoutDueDate })}
          </FieldNote>
        )}
        <FieldNote>{t('calendar.exportHint')}</FieldNote>
        {message && <FieldNote tone={message.tone}>{message.text}</FieldNote>}
      </div>
    </Dialog>
  );
}

function statusLabel(task: PlannedCalendarTask): 'create' | 'update' | 'skip' {
  if (task.status === 'unchanged') return 'skip';
  return task.existingId ? 'update' : 'create';
}

/** What a group's select holds: `skip`, `new`, or `course:{id}`. */
type GroupValue = string;

/** A group whose every session is already in a course: a re-import can only
 * update or cancel them there, so there is nothing to choose. */
function importedCourses(group: TimetableGroup): string[] | null {
  if (!group.sessions.every((session) => session.existing)) return null;
  return [...new Set(group.sessions.map((session) => session.existing!.courseId))];
}

/** The suggestion when it names a course still here; otherwise a new course
 * named after the category, and nothing at all for the uncategorised — a
 * pile of events with no course name is as likely to be noise as lectures. */
function defaultGroupValue(
  group: TimetableGroup,
  courses: readonly Course[],
): GroupValue {
  const suggested = group.suggestedCourseId;
  if (suggested && courses.some((course) => course.id === suggested))
    return `course:${suggested}`;
  return group.label ? 'new' : 'skip';
}

function groupChoice(group: TimetableGroup, value: GroupValue): GroupChoice {
  if (value.startsWith('course:')) return { kind: 'course', courseId: value.slice(7) };
  if (value === 'new' && group.label) return { kind: 'new', name: group.label };
  return { kind: 'skip' };
}

function groupCounts(group: TimetableGroup) {
  const count = (status: TimetableGroup['sessions'][number]['status']) =>
    group.sessions.filter((session) => session.status === status).length;
  return {
    new: count('new'),
    changed: count('changed'),
    cancelled: count('cancelled'),
  };
}

/** What the import would write for the timetable, and into how many courses
 * the new sessions go. Changed and cancelled sessions are written whatever
 * the group's choice: they already live in a course. */
function timetableWrites(
  plan: TimetablePlan,
  values: Readonly<Record<string, GroupValue>>,
): { sessions: number; courses: number } {
  let sessions = 0;
  const targets = new Set<string>();
  for (const group of plan.groups) {
    const counts = groupCounts(group);
    sessions += counts.changed + counts.cancelled;
    const value = values[group.key] ?? 'skip';
    if (counts.new && value !== 'skip') {
      sessions += counts.new;
      targets.add(value === 'new' ? `new:${group.key}` : value);
    }
  }
  return { sessions, courses: targets.size };
}

interface ImportResult {
  tasks: CalendarImportSummary | null;
  timetable: (TimetableImportSummary & { courses: number }) | null;
}

export function CalendarImportDialog() {
  const { t, i18n } = useTranslation();
  const open = useUiStore((state) => state.calendarImportOpen);
  const setOpen = useUiStore((state) => state.setCalendarImportOpen);
  const courses = useLibraryStore((state) => state.courses);

  const [file, setFile] = useState<{
    name: string;
    plan: CalendarPlan;
    timetable: TimetablePlan;
  } | null>(null);
  const [filter, setFilter] = useState<CalendarFilter>({
    which: 'deadlines',
    includePast: false,
  });
  const [courseId, setCourseId] = useState('');
  const [groupValues, setGroupValues] = useState<Record<string, GroupValue>>({});
  const [working, setWorking] = useState(false);
  const [summary, setSummary] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');

  const selected = useMemo(
    () => (file ? selectCalendarTasks(file.plan, filter) : []),
    [file, filter],
  );
  const writing = selected.filter((task) => task.status !== 'unchanged').length;
  const simplified = selected.filter(
    (task) => task.fidelity === 'simplified' || task.fidelity === 'unsupported',
  ).length;
  const timetable = file?.timetable ?? null;
  const sessions = timetable
    ? timetableWrites(timetable, groupValues)
    : { sessions: 0, courses: 0 };
  const skippedSessions =
    timetable?.skipped.filter(
      // Deadlines go to the tasks, and all-day entries are not lectures;
      // neither is news here.
      (entry) => entry.reason !== 'deadline' && entry.reason !== 'allDay',
    ).length ?? 0;

  function close() {
    if (working) return;
    setFile(null);
    setSummary(null);
    setError('');
    setGroupValues({});
    setFilter({ which: 'deadlines', includePast: false });
    setOpen(false);
  }

  async function choose() {
    setError('');
    const result = await readCalendarCommand();
    if (!result.ok) {
      setError(t([`calendar.error.${result.message}`, 'calendar.error.unreadable']));
      return;
    }
    if (!result.value) return;
    if (!result.value.plan.tasks.length && !result.value.timetable.groups.length) {
      setError(t('calendar.error.empty'));
      return;
    }
    setGroupValues(
      Object.fromEntries(
        result.value.timetable.groups.map((group) => {
          const imported = importedCourses(group);
          return [
            group.key,
            imported ? `course:${imported[0]}` : defaultGroupValue(group, courses),
          ];
        }),
      ),
    );
    setFile(result.value);
  }

  async function apply() {
    if (!file) return;
    setWorking(true);
    setError('');
    let tasks: CalendarImportSummary | null = null;
    if (writing > 0) {
      const result = await applyCalendarImportCommand(selected, {
        courseId: courseId || null,
      });
      if (!result.ok) {
        setWorking(false);
        setError(t('calendar.error.applyFailed'));
        return;
      }
      tasks = result.value;
    }
    if (sessions.sessions === 0) {
      setWorking(false);
      setSummary({ tasks, timetable: null });
      return;
    }
    const result = await applyTimetableImportCommand(
      file.timetable,
      new Map(
        file.timetable.groups.map((group) => [
          group.key,
          groupChoice(group, groupValues[group.key] ?? 'skip'),
        ]),
      ),
    );
    setWorking(false);
    // Into the result either way: the tasks are written, and importing again
    // from this plan would write them a second time.
    setSummary({
      tasks,
      timetable: result.ok ? { ...result.value, courses: sessions.courses } : null,
    });
    if (!result.ok) setError(t('calendar.error.timetableFailed'));
  }

  const whichOptions: ChoiceOption<CalendarFilter['which']>[] = [
    {
      value: 'deadlines',
      title: t('calendar.which.deadlines'),
      description: t('calendar.whichHint.deadlines'),
      icon: CalendarClock,
    },
    {
      value: 'all',
      title: t('calendar.which.all'),
      description: t('calendar.whichHint.all'),
      icon: ListChecks,
    },
  ];

  const date = (iso: string, allDay: boolean) =>
    new Date(iso).toLocaleString(i18n.language, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...(allDay ? {} : { hour: 'numeric', minute: '2-digit' }),
    });

  const importLabel =
    sessions.sessions === 0
      ? t('calendar.importButton', { count: writing })
      : writing === 0
        ? t('calendar.timetable.importButton', { count: sessions.sessions })
        : t('calendar.importBoth');

  return (
    <Dialog
      open={open}
      onClose={close}
      closeDisabled={working}
      title={t('calendar.importTitle')}
      description={t('calendar.importDescription')}
      size="lg"
      footer={
        <>
          {!file && (
            <GlassButton size="sm" variant="accent" onClick={() => void choose()}>
              {t('calendar.chooseFile')}
            </GlassButton>
          )}
          {file && !summary && (
            <GlassButton
              size="sm"
              variant="accent"
              disabled={working || writing + sessions.sessions === 0}
              onClick={() => void apply()}
            >
              {importLabel}
            </GlassButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <FieldNote tone="danger">{error}</FieldNote>}
        {!file && <FieldNote>{t('calendar.importHint')}</FieldNote>}

        {file && !summary && (
          <>
            <p className="text-[12px] text-nb-text-3">
              {t('calendar.fileLine', {
                name: file.name,
                count: file.plan.tasks.length,
              })}
            </p>

            {file.timetable.groups.length > 0 && (
              <TimetableSection
                plan={file.timetable}
                courses={courses}
                values={groupValues}
                skipped={skippedSessions}
                onChange={(key, value) =>
                  setGroupValues((current) => ({ ...current, [key]: value }))
                }
              />
            )}

            {file.timetable.groups.length > 0 && (
              <h3 className="-mb-1 mt-1 text-[12px] font-semibold text-[var(--nb-text-2)]">
                {t('calendar.tasksHeading')}
              </h3>
            )}
            <ChoiceGroup<CalendarFilter['which']>
              label={t('calendar.whichLabel')}
              value={filter.which}
              onChange={(which) => setFilter((current) => ({ ...current, which }))}
              options={whichOptions}
            />
            <FieldRow
              label={t('calendar.includePast')}
              hint={t('calendar.includePastHint')}
              align="end"
            >
              <FieldToggle
                label={t('calendar.includePast')}
                checked={filter.includePast}
                onChange={(includePast) =>
                  setFilter((current) => ({ ...current, includePast }))
                }
              />
            </FieldRow>
            <FieldRow label={t('calendar.course')}>
              <GlassSelect
                label={t('calendar.course')}
                size="sm"
                value={courseId}
                onChange={(event) => setCourseId(event.target.value)}
              >
                <option value="">{t('calendar.noCourse')}</option>
                {courses
                  .filter((course) => !course.archived)
                  .map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.name}
                    </option>
                  ))}
              </GlassSelect>
            </FieldRow>

            {(simplified > 0 ||
              file.plan.overrides > 0 ||
              file.plan.warnings.length > 0) && (
              <FieldNote>
                <ul className="list-disc space-y-0.5 pl-4">
                  {simplified > 0 && (
                    <li>{t('calendar.simplified', { count: simplified })}</li>
                  )}
                  {file.plan.overrides > 0 && (
                    <li>{t('calendar.overrides', { count: file.plan.overrides })}</li>
                  )}
                  {file.plan.warnings.map((warning) => (
                    <li key={warning.code}>
                      {t(
                        [`calendar.warning.${warning.code}`, 'calendar.warning.unknown'],
                        {
                          count: warning.count,
                        },
                      )}
                    </li>
                  ))}
                </ul>
              </FieldNote>
            )}

            <section>
              <h3 className="mb-2 text-[12px] font-semibold text-[var(--nb-text-2)]">
                {t('calendar.listLabel', { count: selected.length })}
              </h3>
              {selected.length ? (
                <ul className="max-h-[260px] overflow-auto rounded-lg border border-[var(--nb-divider)] bg-[var(--nb-paper)]">
                  {selected.slice(0, LIST_LIMIT).map((task) => {
                    const action = statusLabel(task);
                    return (
                      <li
                        key={task.importKey}
                        className="flex items-center gap-2 border-b border-[var(--nb-divider)] px-3 py-1.5 last:border-b-0"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] text-nb-text">
                            {task.title}
                          </span>
                          <span className="block truncate text-[11px] text-nb-text-3">
                            {date(task.dueAt, task.event.allDay)}
                            {task.recurrence
                              ? ` · ${t(`calendar.repeats.${task.recurrence.freq}`)}`
                              : ''}
                            {task.fidelity === 'simplified' ||
                            task.fidelity === 'unsupported'
                              ? ` · ${t('calendar.oneOccurrence')}`
                              : ''}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium',
                            action === 'skip'
                              ? 'bg-[var(--nb-hover)] text-nb-text-3'
                              : action === 'update'
                                ? 'bg-[color-mix(in_srgb,var(--nb-warn)_14%,transparent)] text-[var(--nb-warn)]'
                                : 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]',
                          )}
                        >
                          {t(`importSource.action.${action}`)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <FieldNote>{t('calendar.nothingSelected')}</FieldNote>
              )}
              {selected.length > LIST_LIMIT && (
                <p className="mt-1 text-[11px] text-nb-text-3">
                  {t('importSource.andMore', { count: selected.length - LIST_LIMIT })}
                </p>
              )}
            </section>
          </>
        )}

        {summary && (summary.tasks || summary.timetable) && (
          <FieldNote tone="notice">
            {[
              ...(summary.tasks
                ? [
                    t('calendar.done.created', { count: summary.tasks.created }),
                    summary.tasks.updated
                      ? t('calendar.done.updated', { count: summary.tasks.updated })
                      : '',
                    summary.tasks.unchanged
                      ? t('calendar.done.unchanged', { count: summary.tasks.unchanged })
                      : '',
                  ]
                : []),
              ...(summary.timetable ? timetableOutcome(summary.timetable, t) : []),
            ]
              .filter(Boolean)
              .join(' ')}
          </FieldNote>
        )}
      </div>
    </Dialog>
  );
}

function timetableOutcome(
  result: TimetableImportSummary & { courses: number },
  t: ReturnType<typeof useTranslation>['t'],
): string[] {
  const parts = [
    result.added
      ? t('calendar.timetable.done.added', {
          count: result.added,
          courses: t('calendar.timetable.done.courses', { count: result.courses }),
        })
      : '',
    result.updated ? t('calendar.timetable.done.updated', { count: result.updated }) : '',
    result.removed ? t('calendar.timetable.done.removed', { count: result.removed }) : '',
    result.coursesCreated
      ? t('calendar.timetable.done.coursesCreated', { count: result.coursesCreated })
      : '',
  ].filter(Boolean);
  return parts.length ? parts : [t('calendar.timetable.done.upToDate')];
}

function TimetableSection({
  plan,
  courses,
  values,
  skipped,
  onChange,
}: {
  plan: TimetablePlan;
  courses: readonly Course[];
  values: Readonly<Record<string, GroupValue>>;
  skipped: number;
  onChange(key: string, value: GroupValue): void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="nb-calendar-timetable">
      <h3
        id="nb-calendar-timetable"
        className="text-[12px] font-semibold text-[var(--nb-text-2)]"
      >
        {t('calendar.timetable.title')}
      </h3>
      <p className="mt-0.5 text-[11.5px] leading-snug text-nb-text-3">
        {t('calendar.timetable.hint')}
      </p>
      <ul className="mt-2 divide-y divide-[var(--nb-divider)] rounded-lg border border-[var(--nb-divider)] bg-[var(--nb-paper)]">
        {plan.groups.map((group) => {
          const name = group.label ?? t('calendar.timetable.uncategorised');
          const counts = groupCounts(group);
          const imported = importedCourses(group);
          const importedName = imported
            ? imported
                .map((id) => courses.find((course) => course.id === id)?.name ?? name)
                .join(', ')
            : null;
          const summary = [
            counts.new ? t('calendar.timetable.count.new', { count: counts.new }) : '',
            counts.changed
              ? t('calendar.timetable.count.changed', { count: counts.changed })
              : '',
            counts.cancelled
              ? t('calendar.timetable.count.cancelled', { count: counts.cancelled })
              : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li
              key={group.key}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,16rem)] items-center gap-3 px-3 py-1.5"
            >
              <span className="min-w-0">
                <span className="block break-words text-[12.5px] text-nb-text">
                  {name}
                </span>
                <span className="block text-[11px] text-nb-text-3">
                  {summary || t('calendar.timetable.count.upToDate')}
                </span>
              </span>
              {importedName !== null ? (
                <span className="break-words text-[12px] text-nb-text-2">
                  {importedName}
                </span>
              ) : (
                <GlassSelect
                  size="sm"
                  className="w-full"
                  label={t('calendar.timetable.courseFor', { group: name })}
                  value={values[group.key] ?? 'skip'}
                  onChange={(event) => onChange(group.key, event.target.value)}
                >
                  {group.label && (
                    <option value="new">
                      {t('calendar.timetable.newCourse', { name: group.label })}
                    </option>
                  )}
                  {courses
                    .filter(
                      (course) =>
                        !course.archived || course.id === group.suggestedCourseId,
                    )
                    .map((course) => (
                      <option key={course.id} value={`course:${course.id}`}>
                        {course.name}
                      </option>
                    ))}
                  <option value="skip">{t('calendar.timetable.skip')}</option>
                </GlassSelect>
              )}
            </li>
          );
        })}
      </ul>
      {skipped > 0 && (
        <p className="mt-1 text-[11px] text-nb-text-3">
          {t('calendar.timetable.skipped', { count: skipped })}
        </p>
      )}
    </section>
  );
}
