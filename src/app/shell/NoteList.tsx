import { useEffect } from 'react';
import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { viewToQuery } from './viewQuery';
import { cn } from '@/lib/utils/cn';

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function NoteList() {
  const { t, i18n } = useTranslation();
  const notes = useLibraryStore((state) => state.notes);
  const refreshNotes = useLibraryStore((state) => state.refreshNotes);
  const view = useUiStore((state) => state.view);
  const selectedNoteId = useUiStore((state) => state.selectedNoteId);
  const selectNote = useUiStore((state) => state.selectNote);
  const openNote = useEditorStore((state) => state.openNote);

  // The view *is* the query — changing views re-runs it rather than filtering
  // an in-memory list, so behaviour stays identical once FTS5 is behind it.
  useEffect(() => {
    void refreshNotes(viewToQuery(view));
  }, [view, refreshNotes]);

  function onSelect(noteId: string) {
    selectNote(noteId);
    void openNote(noteId);
  }

  return (
    <div className="flex h-full w-full flex-col border-r border-[var(--nb-divider)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--nb-divider)] px-3">
        <span className="text-[12px] text-nb-text-3">
          {t('noteList.count', { count: notes.length })}
        </span>
      </div>

      {notes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-[13px] text-nb-text-2">{t('noteList.empty')}</p>
          <p className="text-[12px] text-nb-text-3">{t('noteList.emptyHint')}</p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto p-1.5">
          {notes.map((note) => (
            <li key={note.id}>
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
                  <span className="shrink-0 text-[11px] text-nb-text-3">
                    {formatDate(note.updatedAt, i18n.language)}
                  </span>
                  <span className="truncate text-[12px] text-nb-text-3">{note.snippet}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
