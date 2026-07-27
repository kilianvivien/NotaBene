import type { Editor } from '@tiptap/core';
import { FilePlus2, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { library } from '@/lib/adapters';
import type { NoteSummary } from '@/lib/schema';

export interface WikiLinkState {
  query: string;
  from: number;
  to: number;
  x: number;
  y: number;
}

export function WikiLinkMenu({
  editor,
  state,
  currentNoteId,
  close,
}: {
  editor: Editor;
  state: WikiLinkState;
  currentNoteId: string | null;
  close(): void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<NoteSummary[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    void library
      .queryNotes({
        text: state.query.trim() || undefined,
        scope: 'live',
        sort: state.query.trim() ? 'relevance' : 'updated',
        limit: 8,
      })
      .then((notes) => {
        if (alive) {
          setItems(notes.filter((note) => note.id !== currentNoteId));
          setActive(0);
        }
      });
    return () => {
      alive = false;
    };
  }, [currentNoteId, state.query]);

  function choose(note: NoteSummary | null) {
    const title = note?.title || state.query.trim();
    if (!title) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: state.from, to: state.to })
      .insertContent({
        type: 'wikiLink',
        attrs: { noteId: note?.id ?? null, title },
      })
      .insertContent(' ')
      .run();
    close();
  }

  useEffect(() => {
    const count = items.length + (state.query.trim() ? 1 : 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((value) => (value + 1) % Math.max(count, 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((value) => (value - 1 + Math.max(count, 1)) % Math.max(count, 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(items[active] ?? null);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  return (
    <div
      className="nb-slash-menu"
      style={{ left: state.x, top: state.y }}
      role="listbox"
      aria-label={t('editor.wikiLinkMenu')}
    >
      {items.map((note, index) => (
        <button
          key={note.id}
          type="button"
          role="option"
          aria-selected={active === index}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(note)}
        >
          <span className="nb-slash-icon">
            <Link2 size={14} />
          </span>
          <span className="truncate">{note.title || t('noteList.untitled')}</span>
        </button>
      ))}
      {state.query.trim() && (
        <button
          type="button"
          role="option"
          aria-selected={active === items.length}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(null)}
        >
          <span className="nb-slash-icon">
            <FilePlus2 size={14} />
          </span>
          <span className="truncate">
            {t('editor.createWikiNote', { title: state.query.trim() })}
          </span>
        </button>
      )}
      {!items.length && !state.query.trim() && <p>{t('editor.noWikiLinks')}</p>}
    </div>
  );
}
