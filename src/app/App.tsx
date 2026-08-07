import { useEffect } from 'react';
import { TitleBar } from './shell/TitleBar';
import { Sidebar } from './shell/Sidebar';
import { NoteList } from './shell/NoteList';
import { EditorPane } from './shell/EditorPane';
import { Inspector } from './shell/Inspector';
import { StatusBar } from './shell/StatusBar';
import { CommandPalette } from './shell/CommandPalette';
import { SettingsWindow } from './settings/SettingsWindow';
import { RecoveryPrompt } from './recovery/RecoveryPrompt';
import { useAppCommands } from './useAppCommands';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore, watchSystemTheme } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { setLocale } from '@/lib/i18n';
import { CollapsiblePane } from './shell/CollapsiblePane';
import { useChromeRevealed } from './shell/useChromeReveal';
import { useFullscreenAttribute } from './shell/useFullscreen';
import { ReadingControls } from './shell/ReadingControls';
import { TemplatePicker } from './organization/TemplatePicker';
import { ExportDialog } from './export/ExportDialog';
import { RewriteDialog } from './ai/RewriteDialog';
import { SynthesisDialog } from './ai/SynthesisDialog';
import { MindMapDialog } from './ai/MindMapDialog';
import { FlashcardsDialog } from './ai/FlashcardsDialog';
import { PodcastDialog } from './ai/PodcastDialog';
import {
  collectAssetGarbageCommand,
  purgeExpiredTrashCommand,
  runOnboardingCommand,
  runScheduledBackupCommand,
} from '@/lib/commands';
import { startAgentBridge } from '@/lib/mcp/agentBridge';
import { useMcpStore, watchMcpStatus } from '@/lib/state/mcpStore';
import { EditorConflictDialog } from './editor/EditorConflictDialog';

/** Pane widths live here rather than in each pane's class list, because the
 * collapse animation has to know them. Each pane still owns everything else
 * about its own layout. */
const SIDEBAR_WIDTH = 228;
const NOTE_LIST_WIDTH = 290;
const INSPECTOR_WIDTH = 280;

/** How often to ask whether a scheduled backup is due. Not how often one runs —
 * that is a day or a week, decided by the command itself. */
const BACKUP_HEARTBEAT_MS = 30 * 60 * 1000;
const LAUNCH_MAINTENANCE_IDLE_MS = 10_000;

export function App() {
  const bootstrap = useLibraryStore((state) => state.bootstrap);
  const loadSettings = useSettingsStore((state) => state.load);
  const locale = useSettingsStore((state) => state.settings.locale);
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const noteListVisible = useUiStore((state) => state.noteListVisible);
  const inspectorVisible = useUiStore((state) => state.inspectorVisible);
  const focusMode = useUiStore((state) => state.focusMode);
  const chromeRevealed = useChromeRevealed();
  useFullscreenAttribute();

  useAppCommands();

  useEffect(() => {
    let active = true;
    let stopAgentBridge = () => {};
    let stopStatusWatch = () => {};
    const stopThemeWatch = watchSystemTheme();
    // The scheduled backup used to run during bootstrap and nowhere else, so a
    // machine left open for a fortnight backed up exactly once. The command is
    // already gated on when the last one ran, so an extra tick is free.
    const backupHeartbeat = window.setInterval(
      () => void runScheduledBackupCommand(),
      BACKUP_HEARTBEAT_MS,
    );
    const maintenanceIdle = window.setTimeout(
      () => void collectAssetGarbageCommand(),
      LAUNCH_MAINTENANCE_IDLE_MS,
    );
    void (async () => {
      await loadSettings();
      setLocale(useSettingsStore.getState().settings.locale);
      await bootstrap();
      await runOnboardingCommand();
      if (!active) return;
      performance.mark('notabene-ready');
      performance.measure('notabene-startup', 'notabene-start', 'notabene-ready');
      document.documentElement.dataset.ready = 'true';
      stopAgentBridge = await startAgentBridge();
      stopStatusWatch = await watchMcpStatus();
      if (!active) {
        stopAgentBridge();
        stopStatusWatch();
        return;
      }
      await useMcpStore.getState().initialize();
      await purgeExpiredTrashCommand();
      await runScheduledBackupCommand();
    })();
    return () => {
      delete document.documentElement.dataset.ready;
      active = false;
      window.clearInterval(backupHeartbeat);
      window.clearTimeout(maintenanceIdle);
      stopAgentBridge();
      stopStatusWatch();
      stopThemeWatch();
    };
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

  useEffect(() => {
    document.documentElement.dataset.chrome = chromeRevealed ? 'revealed' : 'hidden';
    return () => {
      delete document.documentElement.dataset.chrome;
    };
  }, [chromeRevealed]);

  // The shell fills the window edge to edge. The OS draws the actual window
  // frame under Tauri, so nothing here simulates one — a rounded, inset panel
  // would be a second window drawn inside the real one.
  return (
    <div className="nb-shell flex h-full w-full flex-col overflow-hidden bg-[var(--nb-surface)]">
      <TitleBar />
      {/* The panes are not locked shut in concentration mode — toggling one
          peeks it and toggles it away again, which is what keeps the rest of
          the app reachable without leaving the mode. `setFocusMode` closes
          them on entry and puts them back on exit. */}
      <div className="flex min-h-0 flex-1">
        <CollapsiblePane open={sidebarVisible} width={SIDEBAR_WIDTH}>
          <Sidebar />
        </CollapsiblePane>
        <CollapsiblePane open={noteListVisible} width={NOTE_LIST_WIDTH}>
          <NoteList />
        </CollapsiblePane>
        {/* The typewriter look is scoped to this column, not to `html`: warm
            stock and softened ink belong to the page being written, and must
            not follow a peeked inspector or an open dialog around. */}
        <main className="nb-editor-surface relative flex min-w-0 flex-1 flex-col bg-[var(--nb-paper)]">
          <ReadingControls />
          <EditorPane />
        </main>
        <CollapsiblePane open={inspectorVisible} width={INSPECTOR_WIDTH}>
          <Inspector />
        </CollapsiblePane>
      </div>
      <StatusBar />
      <CommandPalette />
      <SettingsWindow />
      {/* Asked before anything else can be typed over: this is the one moment
          the choice is still the user's to make. */}
      <RecoveryPrompt />
      <TemplatePicker />
      <ExportDialog />
      <RewriteDialog />
      <SynthesisDialog />
      <MindMapDialog />
      <FlashcardsDialog />
      <PodcastDialog />
      <EditorConflictDialog />
    </div>
  );
}
