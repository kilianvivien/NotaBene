/**
 * Bringing a library from another app: Obsidian, a Markdown folder, Notion.
 *
 * A second dialog rather than a mode of `ImportDocumentDialog`, which is one
 * document by construction. The shape is the same promise, though: nothing is
 * written until the student has seen what will be — how many notes, where
 * they go, which were imported before, what was left out and why.
 *
 * Every decision the preview shows is `planSourceImportCommand`'s; this file
 * only renders the plan and passes the student's choices to the apply step.
 * Changing what to do with notes imported before re-plans (titles and link
 * targets depend on it); changing where notes go does not.
 */
import {
  BookMarked,
  FileText,
  FolderOpen,
  FolderTree,
  Gem,
  Inbox,
  LockKeyhole,
  NotebookPen,
  RefreshCw,
  SkipForward,
  Copy,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
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
  applySourceImportCommand,
  pickSourceCommand,
  planSourceImportCommand,
  scanSourceCommand,
  sourceAvailable,
  type ImportMapping,
  type ImportSummary,
} from '@/lib/commands';
import {
  SOURCE_IDS,
  type ExistingPolicy,
  type ImportPlan,
  type PlannedNote,
  type SourceId,
  type SourceScan,
} from '@/lib/import/sources';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';

type Stage = 'choose' | 'scanning' | 'preview' | 'importing' | 'done';
type MappingKind = ImportMapping['kind'];

/** Rows drawn in the preview. A vault of 900 notes is summarised by its
 * counts; the list is there to be spot-checked, not read end to end. */
const LIST_LIMIT = 200;

const SOURCE_ICONS: Record<SourceId, LucideIcon> = {
  obsidian: Gem,
  markdownFolder: FolderOpen,
  notion: NotebookPen,
};

function StatusBadge({ note }: { note: PlannedNote }) {
  const { t } = useTranslation();
  const tone =
    note.action === 'skip'
      ? 'text-nb-text-3 bg-[var(--nb-hover)]'
      : note.action === 'update'
        ? 'text-[var(--nb-warn)] bg-[color-mix(in_srgb,var(--nb-warn)_14%,transparent)]'
        : 'text-[var(--nb-accent)] bg-[var(--nb-accent-soft)]';
  return (
    <span
      className={cn('shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium', tone)}
    >
      {t(`importSource.action.${note.action}`)}
    </span>
  );
}

export function ImportSourceDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.sourceImportOpen);
  const setOpen = useUiStore((state) => state.setSourceImportOpen);
  const setView = useUiStore((state) => state.setView);
  const courses = useLibraryStore((state) => state.courses);

  const [stage, setStage] = useState<Stage>('choose');
  const [sourceId, setSourceId] = useState<SourceId>(
    () => SOURCE_IDS.find((id) => sourceAvailable(id)) ?? 'obsidian',
  );
  const [scan, setScan] = useState<SourceScan | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [existing, setExisting] = useState<ExistingPolicy>('update');
  const [mapping, setMapping] = useState<MappingKind>('folders');
  /** `''` is "a new course named after the source". */
  const [courseId, setCourseId] = useState('');
  const [keepTags, setKeepTags] = useState(true);
  const [progress, setProgress] = useState<{ label: string } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState('');
  const run = useRef<AbortController | null>(null);

  function reset() {
    run.current?.abort();
    run.current = null;
    setStage('choose');
    setScan(null);
    setPlan(null);
    setExisting('update');
    setMapping('folders');
    setCourseId('');
    setKeepTags(true);
    setProgress(null);
    setSummary(null);
    setError('');
  }

  function close() {
    if (stage === 'importing') return;
    reset();
    setOpen(false);
  }

  function errorText(message: string): string {
    return t([`importSource.error.${message}`, 'importSource.error.scan_failed']);
  }

  async function replan(next: SourceScan, policy: ExistingPolicy) {
    const planned = await planSourceImportCommand(next, sourceId, policy);
    if (!planned.ok) {
      setError(errorText(planned.message));
      setStage('choose');
      return;
    }
    setPlan(planned.value);
    // A source with no folders has nothing to turn into courses.
    if (!planned.value.folders.length)
      setMapping((current) => (current === 'folders' ? 'course' : current));
    setStage('preview');
  }

  async function chooseAndScan() {
    setError('');
    const picked = await pickSourceCommand(sourceId);
    if (!picked.ok) {
      setError(errorText(picked.message));
      return;
    }
    if (!picked.value) return;
    const controller = new AbortController();
    run.current = controller;
    setStage('scanning');
    setProgress({ label: t('importSource.reading') });
    const scanned = await scanSourceCommand(sourceId, picked.value, {
      signal: controller.signal,
      onProgress: ({ done, total }) =>
        setProgress({ label: t('importSource.readingCount', { done, total }) }),
    });
    run.current = null;
    setProgress(null);
    if (!scanned.ok) {
      if (scanned.code !== 'cancelled') setError(errorText(scanned.message));
      setStage('choose');
      return;
    }
    if (!scanned.value.notes.length) {
      setError(t('importSource.error.empty'));
      setStage('choose');
      return;
    }
    setScan(scanned.value);
    await replan(scanned.value, existing);
  }

  async function changePolicy(policy: ExistingPolicy) {
    setExisting(policy);
    if (scan) await replan(scan, policy);
  }

  async function apply() {
    if (!plan) return;
    setError('');
    setStage('importing');
    setProgress({ label: t('importSource.writing') });
    const target: ImportMapping =
      mapping === 'course'
        ? { kind: 'course', courseId: courseId || null }
        : mapping === 'folders'
          ? { kind: 'folders' }
          : { kind: 'inbox' };
    const result = await applySourceImportCommand(plan, {
      mapping: target,
      keepTags,
      onProgress: ({ phase, done, total }) =>
        setProgress({
          label:
            phase === 'images'
              ? t('importSource.storingImages', { done, total })
              : t('importSource.writing'),
        }),
    });
    setProgress(null);
    if (!result.ok) {
      setError(
        t('importSource.error.applyFailed', {
          count: (result.details as { written?: number } | undefined)?.written ?? 0,
        }),
      );
      setStage('preview');
      return;
    }
    setSummary(result.value);
    setStage('done');
  }

  const sourceOptions: ChoiceOption<SourceId>[] = SOURCE_IDS.map((id) => ({
    value: id,
    title: t(`importSource.source.${id}`),
    description: t(`importSource.sourceHint.${id}`),
    icon: SOURCE_ICONS[id],
    disabled: !sourceAvailable(id),
    badge: sourceAvailable(id) ? undefined : t('importSource.unavailable'),
  }));

  const previouslyImported = plan
    ? plan.notes.filter((note) => note.existingId !== null).length
    : 0;
  const changed = plan?.notes.filter((note) => note.status === 'changed').length ?? 0;

  const policyOptions: ChoiceOption<ExistingPolicy>[] = [
    {
      value: 'update',
      title: t('importSource.policy.update'),
      description: t('importSource.policyHint.update', { count: changed }),
      icon: RefreshCw,
    },
    {
      value: 'skip',
      title: t('importSource.policy.skip'),
      description: t('importSource.policyHint.skip'),
      icon: SkipForward,
    },
    {
      value: 'duplicate',
      title: t('importSource.policy.duplicate'),
      description: t('importSource.policyHint.duplicate'),
      icon: Copy,
    },
  ];

  const folderPreview = plan
    ? plan.folders.length > 3
      ? t('importSource.folderListMore', {
          names: plan.folders.slice(0, 3).join(', '),
          count: plan.folders.length - 3,
        })
      : plan.folders.join(', ')
    : '';

  const mappingOptions: ChoiceOption<MappingKind>[] = [
    {
      value: 'folders',
      title: t('importSource.mapping.folders'),
      description: plan?.folders.length
        ? t('importSource.mappingHint.folders', { names: folderPreview })
        : t('importSource.mappingHint.noFolders'),
      icon: FolderTree,
      disabled: !plan?.folders.length,
    },
    {
      value: 'course',
      title: t('importSource.mapping.course'),
      description: t('importSource.mappingHint.course'),
      icon: BookMarked,
    },
    {
      value: 'inbox',
      title: t('importSource.mapping.inbox'),
      description: t('importSource.mappingHint.inbox'),
      icon: Inbox,
    },
  ];

  const writing = plan ? plan.counts.create + plan.counts.update : 0;

  const footer = (
    <>
      {stage === 'preview' && (
        <GlassButton size="sm" className="mr-auto" onClick={reset}>
          {t('importSource.back')}
        </GlassButton>
      )}
      {stage === 'scanning' && (
        <GlassButton size="sm" onClick={() => run.current?.abort()}>
          {t('importSource.stopScan')}
        </GlassButton>
      )}
      {stage === 'choose' && (
        <GlassButton
          size="sm"
          variant="accent"
          disabled={!sourceAvailable(sourceId)}
          onClick={() => void chooseAndScan()}
        >
          {sourceId === 'notion'
            ? t('importSource.chooseFile')
            : t('importSource.chooseFolder')}
        </GlassButton>
      )}
      {(stage === 'preview' || stage === 'importing') && (
        <GlassButton
          size="sm"
          variant="accent"
          disabled={stage === 'importing' || writing === 0}
          onClick={() => void apply()}
        >
          {stage === 'importing'
            ? t('importSource.importing')
            : t('importSource.import', { count: writing })}
        </GlassButton>
      )}
      {stage === 'done' && summary?.courseId && (
        <GlassButton
          size="sm"
          variant="accent"
          onClick={() => {
            setView({ kind: 'course', courseId: summary.courseId! });
            close();
          }}
        >
          {t('importSource.showCourse')}
        </GlassButton>
      )}
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      closeDisabled={stage === 'importing'}
      title={t('importSource.title')}
      description={t('importSource.description')}
      size="lg"
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        {error && <FieldNote tone="danger">{error}</FieldNote>}

        {stage === 'choose' && (
          <ChoiceGroup<SourceId>
            label={t('importSource.sourceLabel')}
            value={sourceId}
            onChange={setSourceId}
            options={sourceOptions}
            columns={1}
          />
        )}

        {(stage === 'scanning' || stage === 'importing') && progress && (
          <FieldNote>{progress.label}</FieldNote>
        )}

        {plan && (stage === 'preview' || stage === 'importing') && (
          <>
            <div className="flex items-center gap-3 rounded-lg border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] px-3 py-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--nb-control-surface)] text-[var(--nb-text-3)]">
                {(() => {
                  const Icon = SOURCE_ICONS[plan.sourceId];
                  return <Icon size={18} />;
                })()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--nb-text)]">
                  {plan.label}
                </p>
                <p className="text-[11px] text-[var(--nb-text-3)]">
                  {t('importSource.summaryLine', {
                    notes: plan.notes.length,
                    images: plan.counts.images,
                    skipped: plan.skipped.length,
                  })}
                </p>
              </div>
              <span className="flex items-center gap-1 text-[10px] text-[var(--nb-text-3)]">
                <LockKeyhole size={11} />
                {t('import.localOnly')}
              </span>
            </div>

            {previouslyImported > 0 && (
              <section>
                <h3 className="mb-2 text-[12px] font-semibold text-[var(--nb-text-2)]">
                  {t('importSource.previouslyImported', { count: previouslyImported })}
                </h3>
                <ChoiceGroup<ExistingPolicy>
                  label={t('importSource.previouslyImported', {
                    count: previouslyImported,
                  })}
                  value={existing}
                  onChange={(policy) => void changePolicy(policy)}
                  options={policyOptions}
                  columns={3}
                  disabled={stage === 'importing'}
                />
                {existing === 'update' && plan.counts.editedSinceImport > 0 && (
                  <FieldNote tone="notice">
                    {t('importSource.editedSinceImport', {
                      count: plan.counts.editedSinceImport,
                    })}
                  </FieldNote>
                )}
              </section>
            )}

            {plan.counts.create > 0 && (
              <section>
                <h3 className="mb-2 text-[12px] font-semibold text-[var(--nb-text-2)]">
                  {t('importSource.whereLabel')}
                </h3>
                <ChoiceGroup<MappingKind>
                  label={t('importSource.whereLabel')}
                  value={mapping}
                  onChange={setMapping}
                  options={mappingOptions}
                  columns={3}
                  disabled={stage === 'importing'}
                />
                {mapping === 'course' && (
                  <FieldRow label={t('importSource.course')}>
                    <GlassSelect
                      label={t('importSource.course')}
                      size="sm"
                      value={courseId}
                      disabled={stage === 'importing'}
                      onChange={(event) => setCourseId(event.target.value)}
                    >
                      <option value="">
                        {t('importSource.newCourse', { name: plan.label })}
                      </option>
                      {courses
                        .filter((course) => !course.archived)
                        .map((course) => (
                          <option key={course.id} value={course.id}>
                            {course.name}
                          </option>
                        ))}
                    </GlassSelect>
                  </FieldRow>
                )}
              </section>
            )}

            {plan.tags.length > 0 && (
              <FieldRow
                label={t('importSource.keepTags', { count: plan.tags.length })}
                hint={t('importSource.keepTagsHint')}
                align="end"
              >
                <FieldToggle
                  label={t('importSource.keepTags', { count: plan.tags.length })}
                  checked={keepTags}
                  disabled={stage === 'importing'}
                  onChange={setKeepTags}
                />
              </FieldRow>
            )}

            {(plan.warnings.length > 0 || plan.counts.renamed > 0) && (
              <FieldNote>
                <ul className="list-disc space-y-0.5 pl-4">
                  {plan.counts.renamed > 0 && (
                    <li>{t('importSource.renamed', { count: plan.counts.renamed })}</li>
                  )}
                  {plan.warnings.map((warning) => (
                    <li key={warning.code}>
                      {t(
                        [
                          `importSource.warning.${warning.code}`,
                          'importSource.warning.unknown',
                        ],
                        { count: warning.count },
                      )}
                    </li>
                  ))}
                </ul>
              </FieldNote>
            )}

            <section>
              <h3 className="mb-2 text-[12px] font-semibold text-[var(--nb-text-2)]">
                {t('importSource.notesLabel')}
              </h3>
              <ul className="max-h-[260px] overflow-auto rounded-lg border border-[var(--nb-divider)] bg-[var(--nb-paper)]">
                {plan.notes.slice(0, LIST_LIMIT).map((note) => (
                  <li
                    key={note.importKey}
                    className="flex items-center gap-2 border-b border-[var(--nb-divider)] px-3 py-1.5 last:border-b-0"
                  >
                    <FileText size={13} className="shrink-0 text-nb-text-3" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-nb-text">
                        {note.title}
                      </span>
                      <span className="block truncate text-[11px] text-nb-text-3">
                        {note.source.displayPath}
                      </span>
                    </span>
                    <StatusBadge note={note} />
                  </li>
                ))}
              </ul>
              {plan.notes.length > LIST_LIMIT && (
                <p className="mt-1 text-[11px] text-nb-text-3">
                  {t('importSource.andMore', { count: plan.notes.length - LIST_LIMIT })}
                </p>
              )}
            </section>

            {plan.skipped.length > 0 && (
              <details className="text-[12px]">
                <summary className="cursor-pointer font-semibold text-[var(--nb-text-2)]">
                  {t('importSource.skippedLabel', { count: plan.skipped.length })}
                </summary>
                <ul className="mt-2 max-h-[160px] overflow-auto">
                  {plan.skipped.slice(0, LIST_LIMIT).map((skip) => (
                    <li key={skip.path} className="flex gap-2 py-0.5">
                      <span className="min-w-0 flex-1 truncate text-nb-text-2">
                        {skip.path}
                      </span>
                      <span className="shrink-0 text-nb-text-3">
                        {t([
                          `importSource.skip.${skip.reason}`,
                          'importSource.skip.unknown',
                        ])}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        {stage === 'done' && summary && (
          <FieldNote>
            {[
              t('importSource.done.created', { count: summary.created }),
              summary.updated
                ? t('importSource.done.updated', { count: summary.updated })
                : '',
              summary.skipped
                ? t('importSource.done.skipped', { count: summary.skipped })
                : '',
              summary.images
                ? t('importSource.done.images', { count: summary.images })
                : '',
              summary.coursesCreated
                ? t('importSource.done.courses', { count: summary.coursesCreated })
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            {summary.imagesFailed > 0 && (
              <span className="mt-1 block text-[var(--nb-danger)]">
                {t('importSource.done.imagesFailed', { count: summary.imagesFailed })}
              </span>
            )}
          </FieldNote>
        )}
      </div>
    </Dialog>
  );
}
