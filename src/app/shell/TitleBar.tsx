import { PanelLeft, PanelRight, Plus, Search, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '@/components/glass';
import { useUiStore } from '@/lib/state/uiStore';
import { runAppCommand } from '@/lib/commands';

/** Frameless macOS title bar. The leading inset clears the traffic lights; the
 * bar itself is the window drag region. */
export function TitleBar() {
  const { t } = useTranslation();
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const inspectorVisible = useUiStore((state) => state.inspectorVisible);
  const searchQuery = useUiStore((state) => state.searchQuery);
  const setSearchQuery = useUiStore((state) => state.setSearchQuery);

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
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          autoComplete="off"
          className="glass-thin h-7 w-full rounded-nb-sm border-[0.5px] border-[var(--nb-glass-border)] pl-8 pr-2.5 text-[13px] placeholder:text-nb-text-3 focus:outline-none"
        />
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
    </header>
  );
}
