/**
 * ⌘K: one field for finding a note and for doing a thing.
 *
 * Two lists, not two modes. A student who wants "the lecture on limits" and one
 * who wants "make flashcards" both start by pressing ⌘K and typing, and asking
 * them to know in advance which of those they are doing is the kind of thing
 * that makes a palette get used once. Notes win the default selection when
 * there are any, because finding is the more common of the two.
 *
 * The action list is `APP_COMMANDS` itself — the same table the native menu bar
 * is generated from — so a command cannot exist in one and not the other, and
 * the accelerator shown here is the accelerator the menu shows. Commands whose
 * phase has not landed are filtered out rather than listed disabled: the menu
 * greys them to show a roadmap, but a search result you cannot pick is noise.
 */
import { CornerDownLeft, FileText, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  APP_COMMAND_IDS,
  APP_COMMANDS,
  isCommandAvailable,
  runAppCommand,
  searchNotesCommand,
  type AppCommandId,
} from '@/lib/commands';
import type { NoteSummary } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { HighlightedSnippet } from './HighlightedSnippet';

/** Tauri accelerator syntax as the symbols a Mac menu would show. */
function shortcut(accelerator: string | undefined): string | null {
  if (!accelerator) return null;
  return accelerator
    .split('+')
    .map((part) => {
      const key = part.toLowerCase();
      if (key === 'cmdorctrl' || key === 'cmd') return '⌘';
      if (key === 'shift') return '⇧';
      if (key === 'alt' || key === 'option') return '⌥';
      if (key === 'ctrl') return '⌃';
      if (key === 'slash') return '/';
      return part.toUpperCase();
    })
    .join('');
}

type Row =
  | { kind: 'note'; id: string; title: string; snippet: string }
  | { kind: 'action'; id: AppCommandId; label: string; keys: string | null };

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.commandPaletteOpen);
  const setOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const selectNote = useUiStore((state) => state.selectNote);

  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // A palette that remembers last time's query is a palette you have to clear
  // before you can use it.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setNotes([]);
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  /** Debounced, and guarded against the earlier search that resolves last. */
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (!term) {
      setNotes([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void searchNotesCommand(term).then((result) => {
        if (live && result.ok) setNotes(result.value);
      });
    }, 90);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const actions = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return APP_COMMAND_IDS.filter(
      (id) => id !== 'app.commandPalette' && isCommandAvailable(id),
    )
      .map((id) => ({
        id,
        label: t(APP_COMMANDS[id].labelKey),
        keys: shortcut(APP_COMMANDS[id].accelerator),
      }))
      .filter((entry) => !term || entry.label.toLocaleLowerCase().includes(term))
      .slice(0, term ? 6 : 8);
  }, [query, t]);

  const rows: Row[] = useMemo(
    () => [
      ...notes.map((note) => ({
        kind: 'note' as const,
        id: note.id,
        title: note.title || t('noteList.untitled'),
        snippet: note.snippet ?? '',
      })),
      ...actions.map((entry) => ({ kind: 'action' as const, ...entry })),
    ],
    [notes, actions, t],
  );

  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(rows.length - 1, 0));
  }, [active, rows.length]);

  // Keyboard navigation moves the selection past the viewport quickly on a
  // short list; scrolling it back into view is what keeps arrow keys usable.
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  async function choose(row: Row | undefined) {
    if (!row) return;
    setOpen(false);
    if (row.kind === 'note') {
      selectNote(row.id);
      await useEditorStore.getState().openNote(row.id);
    } else {
      await runAppCommand(row.id);
    }
  }

  return (
    <div
      className="nb-palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className="nb-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
      >
        <div className="nb-palette-field">
          <Search size={15} aria-hidden />
          <input
            ref={input}
            value={query}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="nb-palette-list"
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false);
              } else if (event.key === 'ArrowDown') {
                setActive((current) => (rows.length ? (current + 1) % rows.length : 0));
              } else if (event.key === 'ArrowUp') {
                setActive((current) =>
                  rows.length ? (current - 1 + rows.length) % rows.length : 0,
                );
              } else if (event.key === 'Enter') {
                void choose(rows[active]);
              } else {
                return;
              }
              event.preventDefault();
            }}
          />
        </div>

        <ul id="nb-palette-list" ref={list} role="listbox" className="nb-palette-list">
          {rows.map((row, index) => (
            <li key={`${row.kind}-${row.id}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                data-active={index === active || undefined}
                onMouseMove={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void choose(row)}
              >
                {row.kind === 'note' ? (
                  <>
                    <FileText size={13} aria-hidden />
                    <span className="nb-palette-label">{row.title}</span>
                    {row.snippet && (
                      <span className="nb-palette-hint">
                        <HighlightedSnippet value={row.snippet} />
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <CornerDownLeft size={13} aria-hidden />
                    <span className="nb-palette-label">{row.label}</span>
                    {row.keys && <kbd>{row.keys}</kbd>}
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>

        {!rows.length && (
          <p className="nb-palette-empty">
            {query.trim() ? t('palette.noResults') : t('palette.hint')}
          </p>
        )}
      </div>
    </div>
  );
}
