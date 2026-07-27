/** Chrome state: which panes are open, what is selected, what the user is
 * looking at. Nothing here is persisted to the library — it is window state,
 * and it is deliberately kept out of `libraryStore` so a re-query never
 * disturbs the user's layout. */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/** What the note list is currently showing. */
export type ViewKind =
  | { kind: 'all' }
  | { kind: 'inbox' }
  | { kind: 'recents' }
  | { kind: 'pinned' }
  | { kind: 'archived' }
  | { kind: 'trash' }
  | { kind: 'course'; courseId: string; sectionId?: string }
  | { kind: 'tag'; tagId: string }
  | { kind: 'savedSearch'; savedSearchId: string }
  | { kind: 'search'; query: string };

export type InspectorTab =
  'info' | 'tags' | 'versions' | 'attachments' | 'backlinks' | 'ai';

/** Settings sections. Future sections stay addressable while their panes are
 * placeholders, so commands and navigation do not change shape between phases. */
export type SettingsTab =
  'general' | 'appearance' | 'editor' | 'aiProviders' | 'backups' | 'agent' | 'about';

interface UiState {
  view: ViewKind;
  selectedNoteId: string | null;
  /** Multi-select for bulk export/synthesis. Always includes
   * `selectedNoteId` when non-empty. */
  multiSelection: string[];
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  inspectorTab: InspectorTab;
  focusMode: boolean;
  commandPaletteOpen: boolean;
  quickSwitcherOpen: boolean;
  templatePickerOpen: boolean;
  exportOpen: boolean;
  aiRewriteOpen: boolean;
  aiSynthesisOpen: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  searchQuery: string;
  searchScope: 'all' | 'course';
  searchCourseId: string | null;
  /** Set while an MCP agent is acting on the library, so the UI can show it. */
  agentBusy: boolean;

  setView(view: ViewKind): void;
  selectNote(noteId: string | null): void;
  toggleInMultiSelection(noteId: string): void;
  clearMultiSelection(): void;
  toggleSidebar(): void;
  toggleInspector(): void;
  setInspectorTab(tab: InspectorTab): void;
  setFocusMode(on: boolean): void;
  setCommandPaletteOpen(open: boolean): void;
  setQuickSwitcherOpen(open: boolean): void;
  setTemplatePickerOpen(open: boolean): void;
  setExportOpen(open: boolean): void;
  setAiRewriteOpen(open: boolean): void;
  setAiSynthesisOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setSettingsTab(tab: SettingsTab): void;
  setSearchQuery(query: string): void;
  setSearchScope(scope: 'all' | 'course'): void;
  setAgentBusy(busy: boolean): void;
}

export const useUiStore = create<UiState>()(
  immer((set) => ({
    view: { kind: 'all' },
    selectedNoteId: null,
    multiSelection: [],
    sidebarVisible: true,
    inspectorVisible: false,
    inspectorTab: 'info',
    focusMode: false,
    commandPaletteOpen: false,
    quickSwitcherOpen: false,
    templatePickerOpen: false,
    exportOpen: false,
    aiRewriteOpen: false,
    aiSynthesisOpen: false,
    settingsOpen: false,
    settingsTab: 'general',
    searchQuery: '',
    searchScope: 'all',
    searchCourseId: null,
    agentBusy: false,

    setView(view) {
      set((state) => {
        state.view = view;
        state.multiSelection = [];
      });
    },

    selectNote(noteId) {
      set((state) => {
        state.selectedNoteId = noteId;
      });
    },

    toggleInMultiSelection(noteId) {
      set((state) => {
        const index = state.multiSelection.indexOf(noteId);
        if (index >= 0) state.multiSelection.splice(index, 1);
        else state.multiSelection.push(noteId);
      });
    },

    clearMultiSelection() {
      set((state) => {
        state.multiSelection = [];
      });
    },

    toggleSidebar() {
      set((state) => {
        state.sidebarVisible = !state.sidebarVisible;
      });
    },

    toggleInspector() {
      set((state) => {
        state.inspectorVisible = !state.inspectorVisible;
      });
    },

    setInspectorTab(tab) {
      set((state) => {
        state.inspectorTab = tab;
        state.inspectorVisible = true;
      });
    },

    setFocusMode(on) {
      set((state) => {
        state.focusMode = on;
        if (on) {
          state.sidebarVisible = false;
          state.inspectorVisible = false;
        }
      });
    },

    setCommandPaletteOpen(open) {
      set((state) => {
        state.commandPaletteOpen = open;
      });
    },

    setQuickSwitcherOpen(open) {
      set((state) => {
        state.quickSwitcherOpen = open;
      });
    },

    setTemplatePickerOpen(open) {
      set((state) => {
        state.templatePickerOpen = open;
      });
    },

    setExportOpen(open) {
      set((state) => {
        state.exportOpen = open;
      });
    },

    setAiRewriteOpen(open) {
      set((state) => {
        state.aiRewriteOpen = open;
      });
    },

    setAiSynthesisOpen(open) {
      set((state) => {
        state.aiSynthesisOpen = open;
      });
    },

    setSettingsOpen(open) {
      set((state) => {
        state.settingsOpen = open;
      });
    },

    setSettingsTab(tab) {
      set((state) => {
        state.settingsTab = tab;
      });
    },

    setSearchQuery(query) {
      set((state) => {
        if (query.trim() && state.view.kind === 'course') {
          state.searchCourseId = state.view.courseId;
        }
        state.searchQuery = query;
        if (query.trim()) {
          state.view = { kind: 'search', query };
        } else if (state.view.kind === 'search') {
          state.view = state.searchCourseId
            ? { kind: 'course', courseId: state.searchCourseId }
            : { kind: 'all' };
        }
      });
    },

    setSearchScope(scope) {
      set((state) => {
        state.searchScope = scope;
      });
    },

    setAgentBusy(busy) {
      set((state) => {
        state.agentBusy = busy;
      });
    },
  })),
);
