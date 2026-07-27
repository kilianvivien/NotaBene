import { useEffect } from 'react';
import { TitleBar } from './shell/TitleBar';
import { Sidebar } from './shell/Sidebar';
import { NoteList } from './shell/NoteList';
import { EditorPane } from './shell/EditorPane';
import { Inspector } from './shell/Inspector';
import { StatusBar } from './shell/StatusBar';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore, watchSystemTheme } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { setLocale } from '@/lib/i18n';

export function App() {
  const bootstrap = useLibraryStore((state) => state.bootstrap);
  const loadSettings = useSettingsStore((state) => state.load);
  const locale = useSettingsStore((state) => state.settings.locale);
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const inspectorVisible = useUiStore((state) => state.inspectorVisible);
  const focusMode = useUiStore((state) => state.focusMode);

  useEffect(() => {
    void loadSettings();
    void bootstrap();
    return watchSystemTheme();
  }, [loadSettings, bootstrap]);

  useEffect(() => {
    setLocale(locale);
  }, [locale]);

  // The shell fills the window edge to edge. The OS draws the actual window
  // frame under Tauri, so nothing here simulates one — a rounded, inset panel
  // would be a second window drawn inside the real one.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {sidebarVisible && !focusMode && <Sidebar />}
        {!focusMode && <NoteList />}
        <main className="flex min-w-0 flex-1 flex-col">
          <EditorPane />
        </main>
        {inspectorVisible && !focusMode && <Inspector />}
      </div>
      <StatusBar />
    </div>
  );
}
