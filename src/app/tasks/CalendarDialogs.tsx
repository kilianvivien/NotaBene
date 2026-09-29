/**
 * Tasks to and from a calendar file (plan §19).
 *
 * Export says, before writing, how many tasks go and how many cannot — a task
 * with no due date has nowhere to be on a calendar. Import shows what it
 * would write and defaults to what looks like a deadline, because a
 * university timetable is mostly class meetings, and those are not tasks.
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
  calendarExportTasks,
  exportCalendarCommand,
  readCalendarCommand,
  type CalendarImportSummary,
} from '@/lib/commands';
import {
  selectCalendarTasks,
  type CalendarFilter,
  type CalendarPlan,
  type PlannedCalendarTask,
} from '@/lib/import/ics';
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

export function CalendarImportDialog() {
  const { t, i18n } = useTranslation();
  const open = useUiStore((state) => state.calendarImportOpen);
  const setOpen = useUiStore((state) => state.setCalendarImportOpen);
  const courses = useLibraryStore((state) => state.courses);

  const [file, setFile] = useState<{ name: string; plan: CalendarPlan } | null>(null);
  const [filter, setFilter] = useState<CalendarFilter>({
    which: 'deadlines',
    includePast: false,
  });
  const [courseId, setCourseId] = useState('');
  const [working, setWorking] = useState(false);
  const [summary, setSummary] = useState<CalendarImportSummary | null>(null);
  const [error, setError] = useState('');

  const selected = useMemo(
    () => (file ? selectCalendarTasks(file.plan, filter) : []),
    [file, filter],
  );
  const writing = selected.filter((task) => task.status !== 'unchanged').length;
  const simplified = selected.filter(
    (task) => task.fidelity === 'simplified' || task.fidelity === 'unsupported',
  ).length;

  function close() {
    if (working) return;
    setFile(null);
    setSummary(null);
    setError('');
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
    if (!result.value.plan.tasks.length) {
      setError(t('calendar.error.empty'));
      return;
    }
    setFile(result.value);
  }

  async function apply() {
    setWorking(true);
    setError('');
    const result = await applyCalendarImportCommand(selected, {
      courseId: courseId || null,
    });
    setWorking(false);
    if (!result.ok) {
      setError(t('calendar.error.applyFailed'));
      return;
    }
    setSummary(result.value);
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
              disabled={working || writing === 0}
              onClick={() => void apply()}
            >
              {t('calendar.importButton', { count: writing })}
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

        {summary && (
          <FieldNote tone="notice">
            {[
              t('calendar.done.created', { count: summary.created }),
              summary.updated
                ? t('calendar.done.updated', { count: summary.updated })
                : '',
              summary.unchanged
                ? t('calendar.done.unchanged', { count: summary.unchanged })
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
          </FieldNote>
        )}
      </div>
    </Dialog>
  );
}
