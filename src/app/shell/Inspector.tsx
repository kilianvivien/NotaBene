import {
  History,
  Info,
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
import { GlassButton, GlassSegmentedControl } from '@/components/glass';
import { AskPanel } from '@/app/ai/AskPanel';
import { AttachmentPanel } from '@/editor/attachments/AttachmentPanel';
import { library } from '@/lib/adapters';
import {
  ensureTagCommand,
  restoreSnapshotCommand,
  updateNoteCommand,
} from '@/lib/commands';
import { docStats, flattenDoc } from '@/lib/notes/docText';
import type { Backlink, Snapshot, Tag as NoteTag } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';

type VisibleTab = 'info' | 'versions' | 'backlinks' | 'attachments' | 'ai';

export function Inspector() {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const tab = useUiStore((state) => state.inspectorTab);
  const setTab = useUiStore((state) => state.setInspectorTab);
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
        className="nb-inspector-tabs w-full"
      />

      {!note ? (
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
        const first = entries[0];
        if (first) {
          void library.getSnapshot(first.id).then((snapshot) => {
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
      <select
        value={selected?.id ?? ''}
        onChange={(event) => void choose(event.target.value)}
        className="h-8 w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
        aria-label={t('inspector.versions')}
      >
        {snapshots.map((snapshot) => (
          <option key={snapshot.id} value={snapshot.id}>
            {new Date(snapshot.createdAt).toLocaleString(i18n.language)} ·{' '}
            {t(`versions.cause.${snapshot.cause}`)}
          </option>
        ))}
      </select>
      {selected && current && (
        <div className="grid grid-cols-2 gap-2">
          <VersionPreview
            label={t('versions.saved')}
            title={selected.title}
            text={flattenDoc(selected.doc)}
          />
          <VersionPreview
            label={t('versions.current')}
            title={current.title}
            text={flattenDoc(current.doc)}
          />
        </div>
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

function VersionPreview({
  label,
  title,
  text,
}: {
  label: string;
  title: string;
  text: string;
}) {
  return (
    <section className="min-w-0 rounded-nb-sm border border-[var(--nb-divider)] p-2">
      <p className="text-[10px] uppercase tracking-wide text-nb-text-3">{label}</p>
      <p className="mt-1 truncate text-[11px] font-semibold">{title}</p>
      <p className="mt-1 max-h-44 overflow-y-auto whitespace-pre-wrap text-[11px] text-nb-text-2">
        {text}
      </p>
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
        <select
          className="mt-1 h-8 w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
          value={note.courseId ?? ''}
          onChange={(event) => void updateLocation(event.target.value || null, null)}
        >
          <option value="">{t('sidebar.inbox')}</option>
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.icon} {course.name}
            </option>
          ))}
        </select>
      </label>
      {note.courseId && (
        <label className="mt-3 block text-[12px] text-nb-text-3">
          {t('inspector.section')}
          <select
            className="mt-1 h-8 w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
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
          </select>
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
        `${tag.namespace ? `${tag.namespace}:` : ''}${tag.name}`.localeCompare(
          raw,
          undefined,
          {
            sensitivity: 'accent',
          },
        ) === 0,
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
          className="h-8 min-w-0 flex-1 rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
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
        <datalist id="notabene-tag-options">
          {tags.map((tag) => (
            <option key={tag.id}>
              {tag.namespace ? `${tag.namespace}:` : ''}
              {tag.name}
            </option>
          ))}
        </datalist>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {selected.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--nb-accent-soft)] px-2 py-1 text-[12px] text-[var(--nb-accent)]"
          >
            <Tag size={10} />
            {tag.namespace ? `${tag.namespace}:` : ''}
            {tag.name}
            <button
              type="button"
              aria-label={t('common.delete')}
              onClick={() => void apply(note.tagIds.filter((id) => id !== tag.id))}
            >
              <X size={10} />
            </button>
          </span>
        ))}
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
