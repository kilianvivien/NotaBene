import {
  History,
  PanelLeft,
  PanelRight,
  Plus,
  Save,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassIconButton, GlassSelect } from '@/components/glass';
import { useUiStore } from '@/lib/state/uiStore';
import { runAppCommand } from '@/lib/commands';
import { saveSearchCommand } from '@/lib/commands';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { NameDialog } from '@/app/organization/OrganizationModals';

/** Frameless macOS title bar. The leading inset clears the traffic lights; the
 * bar itself is the window drag region. */
export function TitleBar() {
  const { t } = useTranslation();
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const inspectorVisible = useUiStore((state) => state.inspectorVisible);
  const searchQuery = useUiStore((state) => state.searchQuery);
  const setSearchQuery = useUiStore((state) => state.setSearchQuery);
  const searchScope = useUiStore((state) => state.searchScope);
  const setSearchScope = useUiStore((state) => state.setSearchScope);
  const searchCourseId = useUiStore((state) => state.searchCourseId);
  const recentSearches = useSettingsStore((state) => state.settings.recentSearches);
  const updateSettings = useSettingsStore((state) => state.update);
  const [saveSearchOpen, setSaveSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyMatches = recentSearches
    .filter(
      (entry) =>
        !searchQuery.trim() ||
        entry.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()),
    )
    .slice(0, 6);

  // Through the command router, not straight at the store: a toolbar button and
  // its menu item must be the same action, or they drift.
  return (
    <header
      data-tauri-drag-region="true"
      className="flex h-[var(--nb-titlebar-height)] shrink-0 items-center gap-2 border-b border-[var(--nb-divider)] bg-[var(--nb-chrome-surface)] pr-3"
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
              setHistoryOpen(true);
            }}
            onFocus={() => setHistoryOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setHistoryOpen(false);
                return;
              }
              if (event.key !== 'Enter' || !searchQuery.trim()) return;
              const recent = [
                searchQuery.trim(),
                ...recentSearches.filter((entry) => entry !== searchQuery.trim()),
              ].slice(0, 10);
              void updateSettings({ recentSearches: recent });
              setHistoryOpen(false);
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            autoComplete="off"
            className="nb-search-input glass-thin h-7 w-full rounded-nb-sm border-[0.5px] border-[var(--nb-glass-border)] pl-8 pr-12 text-[13px] placeholder:text-nb-text-3 focus:outline-none"
            aria-expanded={historyOpen && historyMatches.length > 0}
            aria-controls="notabene-recent-searches"
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
                setHistoryOpen(false);
              }}
              className="absolute right-[26px] top-1/2 grid size-[18px] -translate-y-1/2 place-items-center rounded-nb-xs text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text"
            >
              <X size={12} />
            </button>
          )}
          {historyOpen && historyMatches.length > 0 && (
            <div
              id="notabene-recent-searches"
              role="listbox"
              aria-label={t('search.recent')}
              className="absolute left-0 right-0 top-[calc(100%+6px)] z-[80] overflow-hidden rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-menu-surface)] p-1.5 text-nb-text shadow-[var(--nb-shadow-lg)]"
            >
              <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-nb-text-3">
                {t('search.recent')}
              </p>
              {historyMatches.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="option"
                  aria-selected={entry === searchQuery}
                  className="flex h-8 w-full items-center gap-2 rounded-nb-xs px-2 text-left text-[12px] text-nb-text-2 hover:bg-[var(--nb-hover)] hover:text-nb-text focus:bg-[var(--nb-hover)] focus:outline-none"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setSearchQuery(entry);
                    setHistoryOpen(false);
                  }}
                >
                  <History size={12} className="shrink-0 text-nb-text-3" aria-hidden />
                  <span className="truncate">{entry}</span>
                </button>
              ))}
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

      <GlassIconButton
        label={t('menu.toggleInspector')}
        active={inspectorVisible}
        onClick={() => void runAppCommand('view.toggleInspector')}
      >
        <PanelRight size={16} />
      </GlassIconButton>

      {/* The desktop build reaches Settings from the app menu too; the browser
          build has only this. */}
      <GlassIconButton
        label={t('settings.title')}
        onClick={() => void runAppCommand('app.settings')}
      >
        <Settings size={16} />
      </GlassIconButton>

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
