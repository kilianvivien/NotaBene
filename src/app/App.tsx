import { useEffect } from 'react';
import { TitleBar } from './shell/TitleBar';
import { Sidebar } from './shell/Sidebar';
import { NoteList } from './shell/NoteList';
import { EditorPane } from './shell/EditorPane';
import { Inspector } from './shell/Inspector';
import { StatusBar } from './shell/StatusBar';
import { SettingsWindow } from './settings/SettingsWindow';
import { RecoveryPrompt } from './recovery/RecoveryPrompt';
import { useAppCommands } from './useAppCommands';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore, watchSystemTheme } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { setLocale } from '@/lib/i18n';
import { CollapsiblePane } from './shell/CollapsiblePane';
import { TemplatePicker } from './organization/TemplatePicker';

/** Pane widths live here rather than in each pane's class list, because the
 * collapse animation has to know them. Each pane still owns everything else
 * about its own layout. */
const SIDEBAR_WIDTH = 228;
const NOTE_LIST_WIDTH = 290;
const INSPECTOR_WIDTH = 280;

export function App() {
  const bootstrap = useLibraryStore((state) => state.bootstrap);
  const loadSettings = useSettingsStore((state) => state.load);
  const locale = useSettingsStore((state) => state.settings.locale);
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const inspectorVisible = useUiStore((state) => state.inspectorVisible);
  const focusMode = useUiStore((state) => state.focusMode);

  useAppCommands();

  useEffect(() => {
    void loadSettings();
    void bootstrap();
    return watchSystemTheme();
  }, [loadSettings, bootstrap]);

  useEffect(() => {
    setLocale(locale);
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.focus = String(focusMode);
    return () => {
      delete document.documentElement.dataset.focus;
    };
  }, [focusMode]);

  // The shell fills the window edge to edge. The OS draws the actual window
  // frame under Tauri, so nothing here simulates one — a rounded, inset panel
  // would be a second window drawn inside the real one.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--nb-surface)]">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <CollapsiblePane open={sidebarVisible && !focusMode} width={SIDEBAR_WIDTH}>
          <Sidebar />
        </CollapsiblePane>
        <CollapsiblePane open={!focusMode} width={NOTE_LIST_WIDTH}>
          <NoteList />
        </CollapsiblePane>
        <main className="flex min-w-0 flex-1 flex-col bg-[var(--nb-paper)]">
          <EditorPane />
        </main>
        <CollapsiblePane open={inspectorVisible && !focusMode} width={INSPECTOR_WIDTH}>
          <Inspector />
        </CollapsiblePane>
      </div>
      <StatusBar />
      <SettingsWindow />
      {/* Asked before anything else can be typed over: this is the one moment
          the choice is still the user's to make. */}
      <RecoveryPrompt />
      <TemplatePicker />
    </div>
  );
}
