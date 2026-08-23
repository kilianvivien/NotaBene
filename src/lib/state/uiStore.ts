/** Chrome state: which panes are open, what is selected, what the user is
 * looking at. Nothing here is persisted to the library — it is window state,
 * and it is deliberately kept out of `libraryStore` so a re-query never
 * disturbs the user's layout. */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { DocumentImportSource } from '@/lib/import/documentImport';
import type { Attachment } from '@/lib/schema';

export interface PdfReadingRequest {
  attachment: Attachment;
  page: number;
  annotationId?: string;
}

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
  | { kind: 'search'; query: string }
  /**
   * The one view that is not a note query. The list column shows tasks and the
   * centre column shows the selected task, so `viewToQuery` never runs for it —
   * see the explicit case there, which exists to say so out loud.
   */
  | { kind: 'tasks'; courseId?: string };

export type InspectorTab = 'info' | 'tags' | 'versions' | 'links' | 'tasks' | 'ai';

/** Settings sections. Future sections stay addressable while their panes are
 * placeholders, so commands and navigation do not change shape between phases. */
export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'abbreviations'
  | 'speech'
  | 'dataStorage'
  | 'aiProviders'
  | 'backups'
  | 'agent'
  | 'about';

/** Pane visibility as it stood when concentration mode was entered, so leaving
 * puts the window back rather than dropping the user into a bare shell. */
interface PaneLayout {
  sidebar: boolean;
  noteList: boolean;
  inspector: boolean;
}

/** What the task dialog was opened from. `taskId` set means "edit"; absent
 * means "new", and the rest of the fields seed the form. */
export interface TaskDraft {
  taskId?: string;
  parentId?: string;
  courseId?: string;
  noteIds?: string[];
}

/** A sitting at the desk. `startWords` is the note's word count on entry, so
 * the status bar can report what *this* session produced rather than how long
 * the note is. */
export interface FocusSession {
  startedAt: number;
  startWords: number;
}

interface UiState {
  view: ViewKind;
  selectedNoteId: string | null;
  /**
   * The notes a bulk action applies to.
   *
   * Authoritative whenever it is non-empty; `selectedNoteId` then means only
   * "the note the editor is showing", which may or may not be a member — you
   * can command-click the open note out of a selection, and pretending
   * otherwise would put a note into a merge the student had just removed.
   * Empty means "there is no bulk selection", and every consumer falls back to
   * `selectedNoteId`, which is why a selection shrinking to one collapses to
   * empty rather than to a list of one.
   */
  multiSelection: string[];
  sidebarVisible: boolean;
  noteListVisible: boolean;
  inspectorVisible: boolean;
  /** Long-form navigation is opt-in so headings do not turn an ordinary note
   * into a manuscript workspace unless the writer asks for it. */
  documentMapVisible: boolean;
  inspectorTab: InspectorTab;
  focusMode: boolean;
  /** What to put back on the way out. Null whenever focus mode is off. */
  focusRestore: PaneLayout | null;
  focusSession: FocusSession | null;
  /** Title bar and status bar are pulled back on screen while this is set —
   * the pointer is at a window edge, or chrome holds focus. */
  chromeRevealed: boolean;
  commandPaletteOpen: boolean;
  quickSwitcherOpen: boolean;
  templatePickerOpen: boolean;
  exportOpen: boolean;
  mergeOpen: boolean;
  documentImportSource: DocumentImportSource | null;
  aiRewriteOpen: boolean;
  aiSynthesisOpen: boolean;
  aiMindMapOpen: boolean;
  aiFlashcardsOpen: boolean;
  aiPodcastOpen: boolean;
  /** A deep link from an agent run to the exact before-version it created. */
  requestedSnapshotId: string | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** True when About was opened by the "i" beside a model name rather than by
   * someone browsing Settings. About folds the AI Act notice away by default;
   * arriving through the disclosure is the one case where that notice is the
   * whole reason the page opened, so it must arrive unfolded. */
  aiNoticeRequested: boolean;
  searchQuery: string;
  searchScope: 'all' | 'course';
  searchCourseId: string | null;
  /** Set while an MCP agent is acting on the library, so the UI can show it. */
  agentBusy: boolean;
  pdfReading: PdfReadingRequest | null;
  /** Which task the Tasks view's detail pane is showing. */
  selectedTaskId: string | null;
  /**
   * The task dialog's request, or `null` when it is closed. A draft carries
   * what the dialog was opened *from* — a course row, a parent task, the note
   * on screen — so "new task for this note" needs no second step.
   */
  taskDraft: TaskDraft | null;
  /** Open while the editor is choosing a task to mention inline. */
  taskPickerOpen: boolean;
  /**
   * The task the breakdown dialog is planning, or `null` when it is closed.
   * It carries its own id rather than reading `selectedTaskId`, so a plan
   * cannot land on a different task than the one it was asked about.
   */
  taskBreakdownFor: string | null;
  /** The month view of every dated task. */
  taskCalendarOpen: boolean;

  setView(view: ViewKind): void;
  selectNote(noteId: string | null): void;
  setMultiSelection(noteIds: string[]): void;
  toggleInMultiSelection(noteId: string): void;
  clearMultiSelection(): void;
  toggleSidebar(): void;
  toggleNoteList(): void;
  toggleInspector(): void;
  toggleDocumentMap(): void;
  setInspectorTab(tab: InspectorTab): void;
  setFocusMode(on: boolean, startWords?: number): void;
  toggleFocusMode(startWords?: number): void;
  setChromeRevealed(on: boolean): void;
  setCommandPaletteOpen(open: boolean): void;
  setQuickSwitcherOpen(open: boolean): void;
  setTemplatePickerOpen(open: boolean): void;
  setExportOpen(open: boolean): void;
  setMergeOpen(open: boolean): void;
  setDocumentImportSource(source: DocumentImportSource | null): void;
  setAiRewriteOpen(open: boolean): void;
  setAiSynthesisOpen(open: boolean): void;
  setAiMindMapOpen(open: boolean): void;
  setAiFlashcardsOpen(open: boolean): void;
  setAiPodcastOpen(open: boolean): void;
  requestVersionSnapshot(snapshotId: string | null): void;
  setSettingsOpen(open: boolean): void;
  setSettingsTab(tab: SettingsTab): void;
  requestAiNotice(): void;
  setSearchQuery(query: string): void;
  setSearchScope(scope: 'all' | 'course'): void;
  setAgentBusy(busy: boolean): void;
  openPdfReader(attachment: Attachment, page?: number, annotationId?: string): void;
  closePdfReader(): void;
  selectTask(taskId: string | null): void;
  /** Open the Tasks view, optionally scoped to a course, on a given task. */
  openTasksView(options?: { courseId?: string; taskId?: string }): void;
  openTaskDialog(draft?: TaskDraft): void;
  closeTaskDialog(): void;
  openTaskPicker(): void;
  closeTaskPicker(): void;
  openTaskBreakdown(taskId: string): void;
  closeTaskBreakdown(): void;
  setTaskCalendarOpen(open: boolean): void;
}

/**
 * Is something modal on screen?
 *
 * Two callers need this and must agree: chrome cannot retreat while the command
 * palette is putting focus in the title bar's field, and Escape belongs to
 * whatever is open before it belongs to concentration mode.
 */
export function isOverlayOpen(state: UiState): boolean {
  return (
    state.commandPaletteOpen ||
    state.quickSwitcherOpen ||
    state.templatePickerOpen ||
    state.exportOpen ||
    state.mergeOpen ||
    state.documentImportSource !== null ||
    state.settingsOpen ||
    state.aiRewriteOpen ||
    state.aiSynthesisOpen ||
    state.aiMindMapOpen ||
    state.aiFlashcardsOpen ||
    state.aiPodcastOpen ||
    state.taskDraft !== null ||
    state.taskPickerOpen ||
    state.taskBreakdownFor !== null ||
    state.taskCalendarOpen
  );
}

/**
 * Which notes an action aimed at one row should really touch.
 *
 * Right-clicking or dragging a row that is part of a selection means the
 * selection; doing it to a row outside one means that row alone, and must not
 * silently act on the eleven notes highlighted elsewhere in the list.
 */
export function selectionFor(noteId: string): string[] {
  const { multiSelection } = useUiStore.getState();
  return multiSelection.includes(noteId) ? multiSelection : [noteId];
}

export const useUiStore = create<UiState>()(
  immer((set, get) => ({
    view: { kind: 'all' },
    selectedNoteId: null,
    multiSelection: [],
    selectedTaskId: null,
    taskDraft: null,
    taskPickerOpen: false,
    taskBreakdownFor: null,
    taskCalendarOpen: false,
    sidebarVisible: true,
    noteListVisible: true,
    inspectorVisible: false,
    documentMapVisible: false,
    inspectorTab: 'info',
    focusMode: false,
    focusRestore: null,
    focusSession: null,
    chromeRevealed: false,
    commandPaletteOpen: false,
    quickSwitcherOpen: false,
    templatePickerOpen: false,
    exportOpen: false,
    mergeOpen: false,
    documentImportSource: null,
    aiRewriteOpen: false,
    aiSynthesisOpen: false,
    aiMindMapOpen: false,
    aiFlashcardsOpen: false,
    aiPodcastOpen: false,
    requestedSnapshotId: null,
    settingsOpen: false,
    settingsTab: 'general',
    aiNoticeRequested: false,
    searchQuery: '',
    searchScope: 'all',
    searchCourseId: null,
    agentBusy: false,
    pdfReading: null,

    setView(view) {
      set((state) => {
        state.view = view;
        state.multiSelection = [];
        // Leaving the Tasks view drops the detail pane's subject; coming back
        // should land on the list rather than on whatever was open last week.
        if (view.kind !== 'tasks') state.selectedTaskId = null;
      });
    },

    // Every caller means "put the student in front of this one note" — the
    // palette, a wiki-link, the note a synthesis just produced. None of them
    // means "and keep the eleven notes that were selected a moment ago", so
    // focusing a note ends the bulk selection.
    selectNote(noteId) {
      set((state) => {
        if (state.pdfReading?.attachment.noteId !== noteId) state.pdfReading = null;
        state.selectedNoteId = noteId;
        state.multiSelection = [];
      });
    },

    selectTask(taskId) {
      set((state) => {
        state.selectedTaskId = taskId;
      });
    },

    openTasksView(options = {}) {
      set((state) => {
        state.view = { kind: 'tasks', courseId: options.courseId };
        state.multiSelection = [];
        if (options.taskId !== undefined) state.selectedTaskId = options.taskId;
      });
    },

    openTaskDialog(draft = {}) {
      set((state) => {
        state.taskDraft = draft;
      });
    },

    closeTaskDialog() {
      set((state) => {
        state.taskDraft = null;
      });
    },

    openTaskPicker() {
      set((state) => {
        state.taskPickerOpen = true;
      });
    },

    closeTaskPicker() {
      set((state) => {
        state.taskPickerOpen = false;
      });
    },

    openTaskBreakdown(taskId) {
      set((state) => {
        state.taskBreakdownFor = taskId;
      });
    },

    closeTaskBreakdown() {
      set((state) => {
        state.taskBreakdownFor = null;
      });
    },

    setTaskCalendarOpen(open) {
      set((state) => {
        state.taskCalendarOpen = open;
      });
    },

    openPdfReader(attachment, page = 1, annotationId) {
      set((state) => {
        // The reader covers the window, the way every other attachment preview
        // does, so it leaves the panes behind it exactly as it found them.
        state.pdfReading = {
          attachment,
          page: Math.max(1, Math.floor(page)),
          annotationId,
        };
      });
    },

    closePdfReader() {
      set((state) => {
        state.pdfReading = null;
      });
    },

    setMultiSelection(noteIds) {
      set((state) => {
        state.multiSelection = noteIds.length > 1 ? [...new Set(noteIds)] : [];
      });
    },

    toggleInMultiSelection(noteId) {
      set((state) => {
        // The open note is the implicit first member: command-clicking a second
        // note means "this one as well as the one I am reading", and seeding
        // only the clicked note would quietly drop it from the action.
        const current = state.multiSelection.length
          ? state.multiSelection
          : state.selectedNoteId
            ? [state.selectedNoteId]
            : [];
        const next = current.includes(noteId)
          ? current.filter((id) => id !== noteId)
          : [...current, noteId];
        state.multiSelection = next.length > 1 ? next : [];
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

    toggleNoteList() {
      set((state) => {
        state.noteListVisible = !state.noteListVisible;
      });
    },

    toggleInspector() {
      set((state) => {
        state.inspectorVisible = !state.inspectorVisible;
      });
    },

    toggleDocumentMap() {
      set((state) => {
        state.documentMapVisible = !state.documentMapVisible;
      });
    },

    setInspectorTab(tab) {
      set((state) => {
        state.inspectorTab = tab;
        state.inspectorVisible = true;
      });
    },

    /**
     * Entering records the layout and clears it; leaving puts it back.
     *
     * The panes are *not* locked shut while the mode is on — toggling the
     * sidebar inside concentration mode peeks it and toggles it away again,
     * which is what keeps the rest of the app reachable without a mode change.
     * That is also why the recorded layout wins on exit rather than whatever
     * happens to be peeked at that moment.
     */
    setFocusMode(on, startWords = 0) {
      set((state) => {
        if (state.focusMode === on) return;
        state.focusMode = on;
        state.chromeRevealed = false;
        if (on) {
          state.focusRestore = {
            sidebar: state.sidebarVisible,
            noteList: state.noteListVisible,
            inspector: state.inspectorVisible,
          };
          state.focusSession = { startedAt: Date.now(), startWords };
          state.sidebarVisible = false;
          state.noteListVisible = false;
          state.inspectorVisible = false;
          return;
        }
        const restore = state.focusRestore;
        if (restore) {
          state.sidebarVisible = restore.sidebar;
          state.noteListVisible = restore.noteList;
          state.inspectorVisible = restore.inspector;
        }
        state.focusRestore = null;
        state.focusSession = null;
      });
    },

    toggleFocusMode(startWords = 0) {
      get().setFocusMode(!get().focusMode, startWords);
    },

    setChromeRevealed(on) {
      set((state) => {
        state.chromeRevealed = on;
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

    setMergeOpen(open) {
      set((state) => {
        state.mergeOpen = open;
      });
    },

    setDocumentImportSource(source) {
      set((state) => {
        state.documentImportSource = source;
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

    setAiMindMapOpen(open) {
      set((state) => {
        state.aiMindMapOpen = open;
      });
    },

    setAiFlashcardsOpen(open) {
      set((state) => {
        state.aiFlashcardsOpen = open;
      });
    },

    setAiPodcastOpen(open) {
      set((state) => {
        state.aiPodcastOpen = open;
      });
    },

    requestVersionSnapshot(snapshotId) {
      set((state) => {
        state.requestedSnapshotId = snapshotId;
      });
    },

    setSettingsOpen(open) {
      set((state) => {
        state.settingsOpen = open;
        // Closing spends the request: reopening Settings by the gear is
        // browsing, not asking for the notice again.
        if (!open) state.aiNoticeRequested = false;
      });
    },

    setSettingsTab(tab) {
      set((state) => {
        state.settingsTab = tab;
        if (tab !== 'about') state.aiNoticeRequested = false;
      });
    },

    requestAiNotice() {
      set((state) => {
        state.settingsTab = 'about';
        state.aiNoticeRequested = true;
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
