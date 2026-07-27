import { PanelLeft, PanelRight, Plus, Save, Search, Settings } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '@/components/glass';
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

      <div className="relative mx-auto w-[min(420px,45vw)]">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-nb-text-3"
        />
        <input
          type="search"
          list="notabene-recent-searches"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !searchQuery.trim()) return;
            const recent = [
              searchQuery.trim(),
              ...recentSearches.filter((entry) => entry !== searchQuery.trim()),
            ].slice(0, 10);
            void updateSettings({ recentSearches: recent });
          }}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          autoComplete="off"
          className="glass-thin h-7 w-full rounded-nb-sm border-[0.5px] border-[var(--nb-glass-border)] pl-8 pr-20 text-[13px] placeholder:text-nb-text-3 focus:outline-none"
        />
        <datalist id="notabene-recent-searches">
          {recentSearches.map((entry) => (
            <option key={entry} value={entry} />
          ))}
        </datalist>
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
        {searchCourseId && searchQuery.trim() && (
          <select
            aria-label={t('search.scopeAll')}
            value={searchScope}
            onChange={(event) => setSearchScope(event.target.value as 'all' | 'course')}
            className="absolute right-7 top-1/2 max-w-[72px] -translate-y-1/2 bg-transparent text-[11px] text-nb-text-3 focus:outline-none"
          >
            <option value="all">{t('search.scopeAll')}</option>
            <option value="course">{t('search.scopeCourse')}</option>
          </select>
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
