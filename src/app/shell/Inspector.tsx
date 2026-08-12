import {
  ArrowRight,
  History,
  Info,
  ListTree,
  Link2,
  Paperclip,
  Plus,
  RotateCcw,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, GlassSegmentedControl, GlassSelect } from '@/components/glass';
import { AgentPanel } from '@/app/ai/AgentPanel';
import { AskPanel } from '@/app/ai/AskPanel';
import { AttachmentPanel } from '@/editor/attachments/AttachmentPanel';
import { library } from '@/lib/adapters';
import {
  ensureTagCommand,
  restoreSnapshotCommand,
  updateNoteCommand,
} from '@/lib/commands';
import { compareDocuments } from '@/lib/history/comparison';
import { docStats } from '@/lib/notes/docText';
import { tagLabel, tagQuery } from '@/lib/notes/tagLabel';
import type { Backlink, Snapshot, Tag as NoteTag } from '@/lib/schema';
import { useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';

type VisibleTab = 'info' | 'versions' | 'backlinks' | 'attachments' | 'ai';

export function Inspector() {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const tab = useUiStore((state) => state.inspectorTab);
  const setTab = useUiStore((state) => state.setInspectorTab);
  const agentMode = useAiStore((state) => state.agentMode);
  const visibleTab: VisibleTab = (
    ['info', 'versions', 'backlinks', 'attachments', 'ai'] as const
  ).includes(tab as VisibleTab)
    ? (tab as VisibleTab)
    : 'info';

  return (
    <aside
      aria-label={t('inspector.details')}
      className="flex h-full w-full flex-col gap-4 overflow-y-auto border-l border-[var(--nb-divider)] bg-[var(--nb-sidebar-surface)] p-3"
    >
      <GlassSegmentedControl<VisibleTab>
        label={t('inspector.details')}
        value={visibleTab}
        onChange={setTab}
        options={[
          { value: 'info', label: t('inspector.info'), icon: Info },
          { value: 'versions', label: t('inspector.versions'), icon: History },
          { value: 'backlinks', label: t('inspector.backlinks'), icon: Link2 },
          {
            value: 'attachments',
            label: t('inspector.attachments'),
            icon: Paperclip,
          },
          { value: 'ai', label: t('ai.ask'), icon: Sparkles },
        ]}
        iconOnly
        fill
      />

      {/* The agent is the one panel that works without an open note: its scope
          can be the whole library, and the shortcut that opens this tab is
          reachable from an empty editor. */}
      {visibleTab === 'ai' && agentMode ? (
        <AgentPanel noteId={note?.id ?? null} />
      ) : !note ? (
        <p className="text-[12px] text-nb-text-3">{t('editor.noSelection')}</p>
      ) : visibleTab === 'ai' ? (
        <AskPanel noteId={note.id} />
      ) : visibleTab === 'attachments' ? (
        <AttachmentPanel noteId={note.id} />
      ) : visibleTab === 'backlinks' ? (
        <BacklinksPanel noteId={note.id} />
      ) : visibleTab === 'versions' ? (
        <VersionsPanel noteId={note.id} />
      ) : (
        <InfoPanel />
      )}
    </aside>
  );
}

function VersionsPanel({ noteId }: { noteId: string }) {
  const { t, i18n } = useTranslation();
  const current = useEditorStore((state) => state.note);
  const [snapshots, setSnapshots] = useState<Omit<Snapshot, 'doc'>[]>([]);
  const [selected, setSelected] = useState<Snapshot | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let active = true;
    void library.listSnapshots(noteId).then((entries) => {
      if (active) {
        setSnapshots(entries);
        const requested = useUiStore.getState().requestedSnapshotId;
        const initial = entries.find((entry) => entry.id === requested) ?? entries[0];
        if (initial) {
          void library.getSnapshot(initial.id).then((snapshot) => {
            if (active) setSelected(snapshot);
          });
        } else {
          setSelected(null);
        }
      }
    });
    return () => {
      active = false;
    };
  }, [noteId]);

  async function choose(id: string) {
    useUiStore.getState().requestVersionSnapshot(null);
    setSelected(await library.getSnapshot(id));
  }

  async function restore() {
    if (!selected) return;
    setRestoring(true);
    const result = await restoreSnapshotCommand(selected.id);
    if (result.ok) {
      await useEditorStore.getState().openNote(noteId);
      setSnapshots(await library.listSnapshots(noteId));
    }
    setRestoring(false);
  }

  if (!snapshots.length) {
    return <p className="text-[12px] text-nb-text-3">{t('versions.empty')}</p>;
  }

  return (
    <div className="space-y-3">
      <GlassSelect
        label={t('inspector.versions')}
        size="sm"
        className="w-full"
        value={selected?.id ?? ''}
        onChange={(event) => void choose(event.target.value)}
      >
        {snapshots.map((snapshot) => (
          <option key={snapshot.id} value={snapshot.id}>
            {new Date(snapshot.createdAt).toLocaleString(i18n.language)} ·{' '}
            {t(`versions.cause.${snapshot.cause}`)}
          </option>
        ))}
      </GlassSelect>
      {selected && current && (
        <VersionComparison
          savedTitle={selected.title}
          currentTitle={current.title}
          savedDoc={selected.doc}
          currentDoc={current.doc}
        />
      )}
      <GlassButton
        size="sm"
        variant="accent"
        disabled={!selected || restoring}
        onClick={() => void restore()}
      >
        <RotateCcw size={12} />
        {restoring ? t('versions.restoring') : t('versions.restore')}
      </GlassButton>
    </div>
  );
}

function VersionComparison({
  savedTitle,
  currentTitle,
  savedDoc,
  currentDoc,
}: {
  savedTitle: string;
  currentTitle: string;
  savedDoc: Snapshot['doc'];
  currentDoc: Snapshot['doc'];
}) {
  const { t } = useTranslation();
  const comparison = compareDocuments(savedDoc, currentDoc);
  const direction =
    comparison.delta.words > 0
      ? 'longer'
      : comparison.delta.words < 0
        ? 'shorter'
        : 'sameLength';
  const stats = [
    {
      label: t('versions.words'),
      saved: comparison.saved.words,
      current: comparison.current.words,
      delta: comparison.delta.words,
    },
    {
      label: t('versions.characters'),
      saved: comparison.saved.characters,
      current: comparison.current.characters,
      delta: comparison.delta.characters,
    },
    {
      label: t('versions.sections'),
      saved: comparison.saved.sections,
      current: comparison.current.sections,
      delta: comparison.delta.sections,
    },
  ];

  return (
    <section className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-paper)] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-nb-text-3">
          {t('versions.overview')}
        </p>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            comparison.delta.words === 0
              ? 'bg-[var(--nb-hover)] text-nb-text-2'
              : comparison.delta.words > 0
                ? 'bg-[color-mix(in_srgb,var(--nb-success)_12%,transparent)] text-[var(--nb-success)]'
                : 'bg-[color-mix(in_srgb,var(--nb-warn)_12%,transparent)] text-[var(--nb-warn)]'
          }`}
        >
          {t(`versions.${direction}`, {
            percent: Math.abs(comparison.delta.wordPercent),
          })}
        </span>
      </div>

      <div className="mt-3 rounded-nb-xs bg-[var(--nb-inset-surface)] p-2.5">
        <p className="text-[10px] uppercase tracking-wide text-nb-text-3">
          {savedTitle === currentTitle ? t('versions.title') : t('versions.titleChanged')}
        </p>
        {savedTitle === currentTitle ? (
          <p className="mt-1 text-[12px] font-semibold">{currentTitle}</p>
        ) : (
          <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5 text-[11px]">
            <span className="line-clamp-2 text-nb-text-3">{savedTitle}</span>
            <ArrowRight size={11} className="text-nb-text-3" aria-hidden />
            <span className="line-clamp-2 font-medium">{currentTitle}</span>
          </div>
        )}
      </div>

      <dl className="mt-3 divide-y divide-[var(--nb-divider)]">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1.5 py-1.5 text-[11px]"
          >
            <dt className="text-nb-text-3">{stat.label}</dt>
            <dd className="tabular-nums text-nb-text-3">{stat.saved}</dd>
            <ArrowRight size={10} className="text-nb-text-3" aria-hidden />
            <dd className="min-w-[4.5rem] text-right tabular-nums">
              <span className="font-medium">{stat.current}</span>
              {stat.delta !== 0 && (
                <span
                  className={
                    stat.delta > 0
                      ? 'ml-1 text-[var(--nb-success)]'
                      : 'ml-1 text-[var(--nb-warn)]'
                  }
                >
                  {stat.delta > 0 ? '+' : ''}
                  {stat.delta}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3">
        <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-nb-text-2">
          <ListTree size={12} aria-hidden />
          {t('versions.outline')}
        </h3>
        {comparison.outline.length ? (
          <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
            {comparison.outline.map((entry, index) => (
              <li
                key={`${entry.level}-${entry.text}-${index}`}
                className="flex items-start gap-1.5 rounded-nb-xs px-1.5 py-1 text-[11px]"
                style={{ paddingLeft: `${6 + (entry.level - 1) * 7}px` }}
              >
                <span
                  aria-label={t(`versions.${entry.status}`)}
                  className={
                    entry.status === 'added'
                      ? 'text-[var(--nb-success)]'
                      : entry.status === 'removed'
                        ? 'text-[var(--nb-warn)]'
                        : 'text-nb-text-3'
                  }
                >
                  {entry.status === 'added'
                    ? '+'
                    : entry.status === 'removed'
                      ? '−'
                      : '•'}
                </span>
                <span
                  className={
                    entry.status === 'removed'
                      ? 'line-through text-nb-text-3'
                      : 'text-nb-text-2'
                  }
                >
                  {entry.text}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-[11px] text-nb-text-3">{t('versions.noSections')}</p>
        )}
      </div>
    </section>
  );
}

function InfoPanel() {
  const { t, i18n } = useTranslation();
  const note = useEditorStore((state) => state.note)!;
  const courses = useLibraryStore((state) => state.courses);
  const sectionsByCourse = useLibraryStore((state) => state.sections);
  const sections = note.courseId ? (sectionsByCourse[note.courseId] ?? []) : [];
  const refreshSections = useLibraryStore((state) => state.refreshSections);
  const [versionCount, setVersionCount] = useState(0);

  useEffect(() => {
    let active = true;
    void library.listSnapshots(note.id).then((snapshots) => {
      if (active) setVersionCount(snapshots.length);
    });
    if (note.courseId) void refreshSections(note.courseId);
    return () => {
      active = false;
    };
  }, [note.id, note.courseId, note.updatedAt, refreshSections]);

  async function updateLocation(courseId: string | null, sectionId: string | null) {
    await useEditorStore.getState().flush();
    const result = await updateNoteCommand({ noteId: note.id, courseId, sectionId });
    if (result.ok) await useEditorStore.getState().openNote(note.id);
  }

  return (
    <div className="nb-details-panel">
      <label className="block text-[12px] text-nb-text-3">
        {t('inspector.course')}
        <GlassSelect
          label={t('inspector.course')}
          size="sm"
          className="mt-1 w-full"
          value={note.courseId ?? ''}
          onChange={(event) => void updateLocation(event.target.value || null, null)}
        >
          <option value="">{t('sidebar.inbox')}</option>
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.icon} {course.name}
            </option>
          ))}
        </GlassSelect>
      </label>
      {note.courseId && (
        <label className="mt-3 block text-[12px] text-nb-text-3">
          {t('inspector.section')}
          <GlassSelect
            label={t('inspector.section')}
            size="sm"
            className="mt-1 w-full"
            value={note.sectionId ?? ''}
            onChange={(event) =>
              void updateLocation(note.courseId, event.target.value || null)
            }
          >
            <option value="">—</option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.name}
              </option>
            ))}
          </GlassSelect>
        </label>
      )}
      <dl className="mt-4">
        <div>
          <dt>{t('inspector.created')}</dt>
          <dd>{new Date(note.createdAt).toLocaleString(i18n.language)}</dd>
        </div>
        <div>
          <dt>{t('inspector.modified')}</dt>
          <dd>{new Date(note.updatedAt).toLocaleString(i18n.language)}</dd>
        </div>
        <div>
          <dt>{t('inspector.wordCount')}</dt>
          <dd>{docStats(note.doc).words}</dd>
        </div>
      </dl>
      <section>
        <h3>
          <History size={13} />
          {t('inspector.versions')}
        </h3>
        <p>{t('inspector.versionCount', { count: versionCount })}</p>
      </section>
      <section>
        <h3>
          <Tag size={13} />
          {t('inspector.tags')}
        </h3>
        <TagsPanel />
      </section>
    </div>
  );
}

function TagsPanel() {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note)!;
  const tags = useLibraryStore((state) => state.tags);
  const [value, setValue] = useState('');
  const selected = tags.filter((tag) => note.tagIds.includes(tag.id));

  async function apply(tagIds: string[]) {
    await useEditorStore.getState().flush();
    const result = await updateNoteCommand({ noteId: note.id, tagIds });
    if (result.ok) await useEditorStore.getState().openNote(note.id);
  }

  async function addTag() {
    const raw = value.trim();
    if (!raw) return;
    const separator = raw.indexOf(':');
    const namespace = separator > 0 ? raw.slice(0, separator) : null;
    const name = separator > 0 ? raw.slice(separator + 1) : raw;
    const known = tags.find(
      (tag) =>
        tagQuery(tag).localeCompare(raw, undefined, { sensitivity: 'accent' }) === 0,
    );
    let tag = known;
    if (!tag) {
      const created = await ensureTagCommand({
        name,
        namespace:
          namespace && ['topic', 'prof', 'semester', 'exam', 'type'].includes(namespace)
            ? (namespace as NoteTag['namespace'])
            : null,
      });
      if (!created.ok) return;
      tag = created.value;
    }
    if (!note.tagIds.includes(tag.id)) {
      await apply([...note.tagIds, tag.id]);
    }
    setValue('');
  }

  return (
    <div>
      <div className="flex gap-1">
        <input
          list="notabene-tag-options"
          className="h-7 min-w-0 flex-1 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
          value={value}
          placeholder={t('organization.addTag')}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void addTag();
            }
          }}
        />
        <GlassButton
          size="sm"
          aria-label={t('organization.addTag')}
          onClick={() => void addTag()}
        >
          <Plus size={12} />
        </GlassButton>
        {/* The value is the storage form, because that is what the field
            parses and what search understands; the label beside it is the
            readable one, so the list is not a column of `type:summary`. */}
        <datalist id="notabene-tag-options">
          {tags.map((tag) => (
            <option key={tag.id} value={tagQuery(tag)}>
              {tagLabel(tag, t).full}
            </option>
          ))}
        </datalist>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {selected.map((tag) => {
          const label = tagLabel(tag, t);
          return (
            <span
              key={tag.id}
              title={label.full}
              className="inline-flex items-center gap-1.5 rounded-full border bg-[var(--nb-inset-surface)] px-2 py-1 text-[12px] text-nb-text-2"
              style={{ borderColor: tag.color }}
            >
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: tag.color }}
              />
              {label.facet && (
                <span className="text-[10.5px] uppercase tracking-wide text-nb-text-3">
                  {label.facet}
                </span>
              )}
              {label.name}
              <button
                type="button"
                aria-label={t('common.delete')}
                onClick={() => void apply(note.tagIds.filter((id) => id !== tag.id))}
              >
                <X size={10} />
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function BacklinksPanel({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const selectNote = useUiStore((state) => state.selectNote);
  const openNote = useEditorStore((state) => state.openNote);
  useEffect(() => {
    let active = true;
    void library.listBacklinks(noteId).then((links) => {
      if (active) setBacklinks(links);
    });
    return () => {
      active = false;
    };
  }, [noteId]);

  if (!backlinks.length) {
    return <p className="text-[12px] text-nb-text-3">{t('inspector.noBacklinks')}</p>;
  }
  return (
    <ul className="space-y-1">
      {backlinks.map((link) => (
        <li key={link.sourceId}>
          <button
            type="button"
            className="w-full rounded-nb-sm p-2 text-left hover:bg-[var(--nb-hover)]"
            onClick={() => {
              selectNote(link.sourceId);
              void openNote(link.sourceId);
            }}
          >
            <span className="flex items-center gap-1 text-[12px] font-medium">
              <Link2 size={11} />
              {link.sourceTitle || t('noteList.untitled')}
            </span>
            <span className="mt-0.5 block truncate text-[12px] text-nb-text-3">
              {link.snippet}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
