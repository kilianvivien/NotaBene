import {
  CornerDownLeft,
  FileText,
  Focus,
  History,
  PanelLeft,
  PanelRight,
  Plus,
  Save,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassIconButton, GlassSelect } from '@/components/glass';
import { useUiStore } from '@/lib/state/uiStore';
import { runAppCommand } from '@/lib/commands';
import { saveSearchCommand } from '@/lib/commands';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { NameDialog } from '@/app/organization/OrganizationModals';
import { HighlightedSnippet } from './HighlightedSnippet';
import {
  chooseCommandSearchRow,
  useCommandSearch,
  type CommandSearchRow,
} from './useCommandSearch';

type TitleSearchRow = CommandSearchRow | { kind: 'recent'; id: string; query: string };

/** Frameless macOS title bar. The leading inset clears the traffic lights; the
 * bar itself is the window drag region. */
export function TitleBar() {
  const { t } = useTranslation();
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const inspectorVisible = useUiStore((state) => state.inspectorVisible);
  const focusMode = useUiStore((state) => state.focusMode);
  const searchQuery = useUiStore((state) => state.searchQuery);
  const setSearchQuery = useUiStore((state) => state.setSearchQuery);
  const searchScope = useUiStore((state) => state.searchScope);
  const setSearchScope = useUiStore((state) => state.setSearchScope);
  const searchCourseId = useUiStore((state) => state.searchCourseId);
  const recentSearches = useSettingsStore((state) => state.settings.recentSearches);
  const updateSettings = useSettingsStore((state) => state.update);
  const [saveSearchOpen, setSaveSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [active, setActive] = useState(0);
  const resultsList = useRef<HTMLUListElement>(null);
  const commandRows = useCommandSearch(searchQuery, historyOpen);
  const historyMatches = recentSearches
    .filter(
      (entry) =>
        !searchQuery.trim() ||
        entry.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()),
    )
    .slice(0, 6);
  const rows: TitleSearchRow[] = useMemo(
    () =>
      searchQuery.trim()
        ? commandRows
        : [
            ...historyMatches.map((query) => ({
              kind: 'recent' as const,
              id: query,
              query,
            })),
            ...commandRows,
          ],
    [commandRows, historyMatches, searchQuery],
  );

  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(rows.length - 1, 0));
  }, [active, rows.length]);

  useEffect(() => {
    resultsList.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function rememberSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    const recent = [query, ...recentSearches.filter((entry) => entry !== query)].slice(
      0,
      10,
    );
    void updateSettings({ recentSearches: recent });
  }

  async function choose(row: TitleSearchRow | undefined) {
    if (!row) {
      rememberSearch();
      setHistoryOpen(false);
      return;
    }
    if (row.kind === 'recent') {
      setSearchQuery(row.query);
      setActive(0);
      setHistoryOpen(false);
      return;
    }
    rememberSearch();
    setHistoryOpen(false);
    if (row.kind === 'action') setSearchQuery('');
    await chooseCommandSearchRow(row);
  }

  // Through the command router, not straight at the store: a toolbar button and
  // its menu item must be the same action, or they drift.
  return (
    <header
      data-tauri-drag-region="true"
      className="nb-chrome-top flex h-[var(--nb-titlebar-height)] shrink-0 items-center gap-2 border-b border-[var(--nb-divider)] bg-[var(--nb-chrome-surface)] pr-3"
      style={{ paddingLeft: 'var(--nb-titlebar-leading)' }}
    >
      <GlassIconButton
        label={t('menu.toggleSidebar')}
        active={sidebarVisible}
        onClick={() => void runAppCommand('view.toggleSidebar')}
      >
        <PanelLeft size={16} />
      </GlassIconButton>

      <GlassIconButton
        label={t('noteList.newNote')}
        onClick={() => void runAppCommand('note.new')}
      >
        <Plus size={16} />
      </GlassIconButton>

      {/* The scope picker sits *beside* the field rather than floating inside
          it. Overlaid on the input it had to be capped at 72px, which cut
          "Everywhere" in half and left no room at all for "Dans ce cours". */}
      <div className="mx-auto flex w-[min(460px,48vw)] min-w-0 items-center gap-1.5">
        <div
          className="relative min-w-0 flex-1"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setHistoryOpen(false);
          }}
        >
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-nb-text-3"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setActive(0);
              setHistoryOpen(true);
            }}
            onFocus={() => {
              setActive(0);
              setHistoryOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setHistoryOpen(false);
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
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            autoComplete="off"
            className="nb-search-input glass-thin h-7 w-full rounded-nb-sm border-[0.5px] border-[var(--nb-glass-border)] pl-8 pr-12 text-[13px] placeholder:text-nb-text-3 focus:outline-none"
            aria-expanded={historyOpen && rows.length > 0}
            aria-controls="notabene-title-search-results"
            role="combobox"
          />
          {/* Ours, not WebKit's. The native search-cancel button is a bright
              blue disc that belongs to Safari's palette and to no theme this
              app has. */}
          {searchQuery && (
            <button
              type="button"
              aria-label={t('common.clear')}
              title={t('common.clear')}
              onClick={() => {
                setSearchQuery('');
                setActive(0);
                setHistoryOpen(false);
              }}
              className="absolute right-[26px] top-1/2 grid size-[18px] -translate-y-1/2 place-items-center rounded-nb-xs text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text"
            >
              <X size={12} />
            </button>
          )}
          {historyOpen && rows.length > 0 && (
            <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-[80] overflow-hidden rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-menu-surface)] text-nb-text shadow-[var(--nb-shadow-lg)]">
              <ul
                id="notabene-title-search-results"
                ref={resultsList}
                role="listbox"
                aria-label={t('palette.title')}
                className="nb-palette-list max-h-[min(46vh,340px)]"
              >
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
                      {row.kind === 'recent' ? (
                        <>
                          <History size={13} aria-hidden />
                          <span className="nb-palette-label">{row.query}</span>
                          <span className="nb-palette-hint">{t('search.recent')}</span>
                        </>
                      ) : row.kind === 'note' ? (
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
            </div>
          )}
          {searchQuery.trim() && (
            <button
              type="button"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-nb-xs p-1 text-nb-text-3 hover:bg-[var(--nb-hover)]"
              aria-label={t('search.saveSearch')}
              onClick={() => setSaveSearchOpen(true)}
            >
              <Save size={12} />
            </button>
          )}
        </div>
        {searchCourseId && searchQuery.trim() && (
          <GlassSelect
            label={t('search.scope')}
            variant="plain"
            size="sm"
            className="shrink-0"
            value={searchScope}
            onChange={(event) => setSearchScope(event.target.value as 'all' | 'course')}
          >
            <option value="all">{t('search.scopeAll')}</option>
            <option value="course">{t('search.scopeCourse')}</option>
          </GlassSelect>
        )}
      </div>

      {/* Concentration mode had no button anywhere — only ⇧⌘F and a View menu
          item, which is a lot of app to hide behind a shortcut nobody was told
          about. */}
      <GlassIconButton
        label={t('menu.focusMode')}
        active={focusMode}
        onClick={() => void runAppCommand('view.focusMode')}
      >
        <Focus size={16} />
      </GlassIconButton>

      <GlassIconButton
        label={t('menu.toggleInspector')}
        active={inspectorVisible}
        onClick={() => void runAppCommand('view.toggleInspector')}
      >
        <PanelRight size={16} />
      </GlassIconButton>

      {/* Settings lives in the status bar now — see `StatusBar`. It is the one
          button here you press once a term, and it was sitting at the same
          weight as the panes you toggle all day. */}

      <NameDialog
        open={saveSearchOpen}
        label={t('search.saveSearch')}
        initialValue={searchQuery}
        onClose={() => setSaveSearchOpen(false)}
        onSubmit={async (name) => {
          const result = await saveSearchCommand({ name, query: searchQuery });
          if (result.ok) setSaveSearchOpen(false);
        }}
      />
    </header>
  );
}
