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
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '@/lib/state/uiStore';
import { CommandSearchRowBody } from './CommandSearchRow';
import {
  chooseCommandSearchRow,
  useCommandSearch,
  type CommandSearchRow,
} from './useCommandSearch';

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.commandPaletteOpen);
  const setOpen = useUiStore((state) => state.setCommandPaletteOpen);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const rows = useCommandSearch(query, open);

  // A palette that remembers last time's query is a palette you have to clear
  // before you can use it.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(rows.length - 1, 0));
  }, [active, rows.length]);

  // Keyboard navigation moves the selection past the viewport quickly on a
  // short list; scrolling it back into view is what keeps arrow keys usable.
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  async function choose(row: CommandSearchRow | undefined) {
    if (!row) return;
    setOpen(false);
    await chooseCommandSearchRow(row);
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
                <CommandSearchRowBody row={row} />
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
