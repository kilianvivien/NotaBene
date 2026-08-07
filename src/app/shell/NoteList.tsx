import { useEffect, useMemo, useRef, useState } from 'react';
import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassSelect, type ContextPoint } from '@/components/glass';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { reorderNotesCommand } from '@/lib/commands';
import { viewToQuery } from './viewQuery';
import { cn } from '@/lib/utils/cn';
import { HighlightedSnippet } from './HighlightedSnippet';
import { NoteContextMenu } from './NoteContextMenu';
import { endDrag, readDrag, startDrag } from './dnd';
import type { NoteSummary } from '@/lib/schema';

const ROW_HEIGHT = 62;
const OVERSCAN = 5;

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function NoteList() {
  const { t, i18n } = useTranslation();
  const notes = useLibraryStore((state) => state.notes);
  const totalNotes = useLibraryStore((state) => state.totalNotes);
  const refreshNotes = useLibraryStore((state) => state.refreshNotes);
  const appendNotes = useLibraryStore((state) => state.appendNotes);
  const courses = useLibraryStore((state) => state.courses);
  const tags = useLibraryStore((state) => state.tags);
  const savedSearches = useLibraryStore((state) => state.savedSearches);
  const view = useUiStore((state) => state.view);
  const searchScope = useUiStore((state) => state.searchScope);
  const searchCourseId = useUiStore((state) => state.searchCourseId);
  const selectedNoteId = useUiStore((state) => state.selectedNoteId);
  const selectNote = useUiStore((state) => state.selectNote);
  const openNote = useEditorStore((state) => state.openNote);
  const viewSorts = useSettingsStore((state) => state.settings.viewSorts);
  const updateSettings = useSettingsStore((state) => state.update);
  const key = viewKey(view);
  const defaultSort = view.kind === 'search' ? 'relevance' : 'updated';
  const sort = viewSorts[key] ?? defaultSort;
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    note: NoteSummary;
    point: ContextPoint;
  } | null>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLLIElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = scrollArea.current;
    if (!element) return;
    const update = () => setViewportHeight(element.clientHeight);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = scrollArea.current;
    const target = sentinel.current;
    if (!root || !target || notes.length >= totalNotes) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void appendNotes();
      },
      { root, rootMargin: '240px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [appendNotes, notes.length, totalNotes]);

  const visibleNotes = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(
      notes.length,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
    );
    return notes.slice(start, end).map((note, index) => ({
      note,
      index: start + index,
    }));
  }, [notes, scrollTop, viewportHeight]);

  // The view *is* the query — changing views re-runs it rather than filtering
  // an in-memory list, so behaviour stays identical once FTS5 is behind it.
  useEffect(() => {
    void refreshNotes(
      viewToQuery(view, {
        courses,
        tags,
        savedSearches,
        sort,
        searchScope,
        searchCourseId,
      }),
    );
  }, [
    view,
    refreshNotes,
    courses,
    tags,
    savedSearches,
    sort,
    searchScope,
    searchCourseId,
  ]);

  function onSelect(noteId: string) {
    selectNote(noteId);
    void openNote(noteId);
  }

  return (
    <div className="flex h-full w-full flex-col border-r border-[var(--nb-divider)] bg-[var(--nb-list-surface)]">
      {/* The count yields before the sort control does: which order you are
          looking at is the thing you came here to read, and "12 notes" survives
          being clipped in a way "Dernière modification" does not. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--nb-divider)] px-3">
        <span className="min-w-0 shrink truncate text-[12px] text-nb-text-3">
          {notes.length < totalNotes
            ? t('noteList.countPaged', { shown: notes.length, total: totalNotes })
            : t('noteList.count', { count: totalNotes })}
        </span>
        <GlassSelect
          label={t('noteList.sortBy')}
          variant="plain"
          size="sm"
          className="ml-auto shrink-0"
          value={sort}
          onChange={(event) =>
            void updateSettings({
              viewSorts: {
                ...viewSorts,
                [key]: event.target.value as typeof sort,
              },
            })
          }
        >
          <option value="updated">{t('noteList.sort.updated')}</option>
          <option value="created">{t('noteList.sort.created')}</option>
          <option value="title">{t('noteList.sort.title')}</option>
          {view.kind === 'course' && (
            <option value="manual">{t('noteList.sort.manual')}</option>
          )}
          {view.kind === 'search' && (
            <option value="relevance">{t('noteList.sort.relevance')}</option>
          )}
        </GlassSelect>
      </div>

      {notes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-[13px] text-nb-text-2">{t('noteList.empty')}</p>
          <p className="text-[12px] text-nb-text-3">{t('noteList.emptyHint')}</p>
        </div>
      ) : (
        <div
          ref={scrollArea}
          className="flex-1 overflow-y-auto"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <ul className="relative mx-1.5" style={{ height: notes.length * ROW_HEIGHT }}>
            {visibleNotes.map(({ note, index }) => (
              <li
                key={note.id}
                className="absolute inset-x-0"
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                draggable
                onDragStart={(event) => {
                  setDraggedNoteId(note.id);
                  startDrag(event, 'note', note.id, note.title || t('noteList.untitled'));
                }}
                onDragEnd={() => {
                  endDrag();
                  setDraggedNoteId(null);
                }}
                onDragOver={(event) => {
                  // Reordering is a course-view affordance only; everywhere else
                  // the order is the query's to decide.
                  if (view.kind === 'course') event.preventDefault();
                }}
                onDrop={(event) => {
                  if (view.kind !== 'course') return;
                  const moved = readDrag(event, 'note') ?? draggedNoteId;
                  if (!moved || moved === note.id) return;
                  event.preventDefault();
                  const ids = notes.map((candidate) => candidate.id);
                  const from = ids.indexOf(moved);
                  const to = ids.indexOf(note.id);
                  if (from === -1 || to === -1) return;
                  ids.splice(to, 0, ids.splice(from, 1)[0]!);
                  void updateSettings({
                    viewSorts: { ...viewSorts, [key]: 'manual' },
                  }).then(() => reorderNotesCommand(ids));
                  endDrag();
                  setDraggedNoteId(null);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  selectNote(note.id);
                  setContextMenu({
                    note,
                    point: { x: event.clientX, y: event.clientY },
                  });
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(note.id)}
                  aria-current={selectedNoteId === note.id ? 'true' : undefined}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-nb-sm px-2.5 py-2 text-left',
                    'transition-colors duration-[var(--nb-t-fast)]',
                    selectedNoteId === note.id
                      ? 'bg-[var(--nb-accent-soft)]'
                      : 'hover:bg-[var(--nb-hover)]',
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    {note.pinned && (
                      <Pin size={11} className="shrink-0 text-[var(--nb-accent)]" />
                    )}
                    <span className="truncate text-[13px] font-medium">
                      {note.title || t('noteList.untitled')}
                    </span>
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span className="shrink-0 text-[12px] text-nb-text-3">
                      {formatDate(note.updatedAt, i18n.language)}
                    </span>
                    <span className="truncate text-[12px] text-nb-text-3">
                      <HighlightedSnippet value={note.snippet} />
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {notes.length < totalNotes && (
              <li
                ref={sentinel}
                aria-hidden
                className="absolute inset-x-0 h-px"
                style={{ top: Math.max(0, notes.length * ROW_HEIGHT - 1) }}
              />
            )}
          </ul>
        </div>
      )}
      {contextMenu && (
        <NoteContextMenu
          note={contextMenu.note}
          point={contextMenu.point}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function viewKey(view: ReturnType<typeof useUiStore.getState>['view']): string {
  switch (view.kind) {
    case 'course':
      return `course:${view.courseId}:${view.sectionId ?? ''}`;
    case 'tag':
      return `tag:${view.tagId}`;
    case 'savedSearch':
      return `saved:${view.savedSearchId}`;
    default:
      return view.kind;
  }
}
