import { PanelLeft, PanelRight, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '@/components/glass';
import { useUiStore } from '@/lib/state/uiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { createNoteCommand } from '@/lib/commands';

/** Frameless macOS title bar. The leading inset clears the traffic lights; the
 * bar itself is the window drag region. */
export function TitleBar() {
  const { t } = useTranslation();
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const inspectorVisible = useUiStore((state) => state.inspectorVisible);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const toggleInspector = useUiStore((state) => state.toggleInspector);
  const searchQuery = useUiStore((state) => state.searchQuery);
  const setSearchQuery = useUiStore((state) => state.setSearchQuery);
  const selectNote = useUiStore((state) => state.selectNote);
  const openNote = useEditorStore((state) => state.openNote);

  async function onNewNote() {
    const result = await createNoteCommand({});
    if (!result.ok) return;
    // Select *and* open: a new note that does not land you in the editor is a
    // new note you have to go and find.
    selectNote(result.value.id);
    await openNote(result.value.id);
  }

  return (
    <header
      data-tauri-drag-region="true"
      className="flex h-[var(--nb-titlebar-height)] shrink-0 items-center gap-2 border-b border-[var(--nb-divider)] pr-3"
      style={{ paddingLeft: 'var(--nb-titlebar-leading)' }}
    >
      <GlassIconButton
        label={t('sidebar.allNotes')}
        active={sidebarVisible}
        onClick={toggleSidebar}
      >
        <PanelLeft size={16} />
      </GlassIconButton>

      <GlassIconButton label={t('noteList.newNote')} onClick={onNewNote}>
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
        label={t('inspector.info')}
        active={inspectorVisible}
        onClick={toggleInspector}
      >
        <PanelRight size={16} />
      </GlassIconButton>
    </header>
  );
}
