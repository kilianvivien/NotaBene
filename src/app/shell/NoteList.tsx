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
import { SelectionBar } from './SelectionBar';
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
  const multiSelection = useUiStore((state) => state.multiSelection);
  const setMultiSelection = useUiStore((state) => state.setMultiSelection);
  const toggleInMultiSelection = useUiStore((state) => state.toggleInMultiSelection);
  const clearMultiSelection = useUiStore((state) => state.clearMultiSelection);
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
  /** Where a shift-click measures its range from — the last row clicked
   * without shift. Held as an id rather than an index so it survives the list
   * being re-queried, re-sorted, or paged. */
  const rangeAnchor = useRef<string | null>(null);
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

  /**
   * One click handler for three gestures, following the platform:
   *
   * - plain click opens the note and ends any selection;
   * - command-click adds or removes one note *without* opening it, because
   *   loading a note into the editor is exactly what you did not ask for when
   *   you were building a list of twelve;
   * - shift-click takes the run between the last plainly-clicked row and this
   *   one, which is what makes "select this lecture's notes" one gesture.
   *
   * Only loaded rows can be reached: the list pages, and a range cannot span
   * notes that have not arrived.
   */
  function onSelect(noteId: string, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) {
    if (event.shiftKey && rangeAnchor.current && rangeAnchor.current !== noteId) {
      const ids = notes.map((note) => note.id);
      const from = ids.indexOf(rangeAnchor.current);
      const to = ids.indexOf(noteId);
      if (from !== -1 && to !== -1) {
        setMultiSelection(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      toggleInMultiSelection(noteId);
      rangeAnchor.current = noteId;
      return;
    }
    rangeAnchor.current = noteId;
    selectNote(noteId);
    void openNote(noteId);
  }

  /** A row is highlighted by the bulk selection when there is one, and by the
   * open note otherwise — the two never both decide, or command-clicking the
   * open note out of a selection would leave it looking as though it stayed. */
  function isSelected(noteId: string): boolean {
    return multiSelection.length
      ? multiSelection.includes(noteId)
      : selectedNoteId === noteId;
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

      <SelectionBar />

      {notes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-[13px] text-nb-text-2">{t('noteList.empty')}</p>
          <p className="text-[12px] text-nb-text-3">{t('noteList.emptyHint')}</p>
        </div>
      ) : (
        <div
          ref={scrollArea}
          // `pt-1`: a row's highlight is a filled rounded rectangle, and butted
          // straight against the divider above it, it reads as part of the
          // chrome rather than as a row. The gap belongs to the scroll area so
          // it holds whether the selection bar is on screen or not.
          className="flex-1 overflow-y-auto pt-1"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          // Scoped to the list rather than the window: Escape already belongs
          // to whatever dialog is open and then to concentration mode, and a
          // global handler here would take it from both.
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !multiSelection.length) return;
            event.stopPropagation();
            clearMultiSelection();
          }}
        >
          <ul
            role="listbox"
            aria-multiselectable
            aria-label={t('noteList.label')}
            className="relative mx-1.5"
            style={{ height: notes.length * ROW_HEIGHT }}
          >
            {visibleNotes.map(({ note, index }) => (
              <li
                key={note.id}
                role="presentation"
                className="absolute inset-x-0"
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                draggable
                onDragStart={(event) => {
                  setDraggedNoteId(note.id);
                  // The payload stays one id — the drop targets expand it back
                  // to the selection through `selectionFor`, which keeps the
                  // typed-MIME contract in `dnd.ts` unchanged.
                  const label =
                    multiSelection.includes(note.id) && multiSelection.length > 1
                      ? t('noteList.selectedCount', { count: multiSelection.length })
                      : note.title || t('noteList.untitled');
                  startDrag(event, 'note', note.id, label);
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
                  // Right-clicking inside a selection keeps it: the menu is
                  // about to offer actions on all of it, and collapsing to the
                  // clicked row first would throw away what was asked for.
                  if (!multiSelection.includes(note.id)) selectNote(note.id);
                  setContextMenu({
                    note,
                    point: { x: event.clientX, y: event.clientY },
                  });
                }}
              >
                <button
                  type="button"
                  role="option"
                  onClick={(event) => onSelect(note.id, event)}
                  aria-current={selectedNoteId === note.id ? 'true' : undefined}
                  aria-selected={isSelected(note.id)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-nb-sm px-2.5 py-2 text-left',
                    'transition-colors duration-[var(--nb-t-fast)]',
                    isSelected(note.id)
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
