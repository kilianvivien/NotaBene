/**
 * The library as the UI sees it: courses, sections, tags, and the summaries for
 * the current view.
 *
 * This store is a *cache of reads*, never a source of truth. Mutations go
 * through `src/lib/commands/`, which writes to the adapter and then asks this
 * store to refresh. Components therefore cannot drift from what is on disk, and
 * an agent write shows up in the UI by exactly the same route a user write does.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { library } from '@/lib/adapters';
import type { NoteQuery, TaskQuery } from '@/lib/adapters';
import type {
  Course,
  NoteSummary,
  NoteTemplate,
  PendingRecovery,
  SavedSearch,
  Section,
  Tag,
  Task,
  TaskNoteLink,
} from '@/lib/schema';

interface LibraryState {
  courses: Course[];
  /** Sections by course id; loaded lazily as courses are expanded. */
  sections: Record<string, Section[]>;
  tags: Tag[];
  savedSearches: SavedSearch[];
  templates: NoteTemplate[];
  notes: NoteSummary[];
  totalNotes: number;
  loadingMore: boolean;
  /** Unsaved editor state a crash left behind, waiting to be offered back. */
  pendingRecoveries: PendingRecovery[];
  loading: boolean;
  error: string | null;
  /** The query behind `notes`, remembered so anything that mutates a note can
   * refresh the list without knowing which view is on screen. */
  lastQuery: NoteQuery;
  /**
   * Every live task, not just the current filter's. The sidebar badge counts
   * what is overdue across the whole library while the Tasks view may be
   * showing one course, so a filtered cache would make the two disagree.
   */
  tasks: Task[];
  taskNoteLinks: TaskNoteLink[];
  /** The query behind the Tasks view, remembered the way `lastQuery` is. */
  lastTaskQuery: TaskQuery;

  /** Load everything the sidebar needs. Called once at startup. */
  bootstrap(): Promise<void>;
  refreshCourses(): Promise<void>;
  refreshSections(courseId: string): Promise<void>;
  refreshTags(): Promise<void>;
  refreshSavedSearches(): Promise<void>;
  refreshTemplates(): Promise<void>;
  refreshPendingRecoveries(): Promise<void>;
  /** Re-read every task and link. Called after any task write. */
  refreshTasks(): Promise<void>;
  /** Run a note query and remember it as the current view. */
  refreshNotes(query: NoteQuery): Promise<void>;
  appendNotes(): Promise<void>;
  /** Re-run the last query. Used after any write, so the list never shows a
   * stale title or snippet. */
  refreshCurrentView(): Promise<void>;
}

const DEFAULT_QUERY: NoteQuery = { scope: 'live', sort: 'updated', limit: 200 };
const DEFAULT_TASK_QUERY: TaskQuery = { scope: 'live', sort: 'due' };
let noteQueryGeneration = 0;

export const useLibraryStore = create<LibraryState>()(
  immer((set, get) => ({
    courses: [],
    sections: {},
    tags: [],
    savedSearches: [],
    templates: [],
    notes: [],
    totalNotes: 0,
    loadingMore: false,
    pendingRecoveries: [],
    loading: false,
    error: null,
    lastQuery: DEFAULT_QUERY,
    tasks: [],
    taskNoteLinks: [],
    lastTaskQuery: DEFAULT_TASK_QUERY,

    async bootstrap() {
      set((state) => {
        state.loading = true;
        state.error = null;
      });
      try {
        await library.init();
        await Promise.all([
          get().refreshCourses(),
          get().refreshTags(),
          get().refreshSavedSearches(),
          get().refreshTemplates(),
          get().refreshPendingRecoveries(),
          get().refreshTasks(),
        ]);
        await get().refreshNotes(DEFAULT_QUERY);
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
      } finally {
        set((state) => {
          state.loading = false;
        });
      }
    },

    async refreshCourses() {
      const courses = await library.listCourses();
      set((state) => {
        state.courses = courses;
      });
    },

    async refreshSections(courseId) {
      const sections = await library.listSections(courseId);
      set((state) => {
        state.sections[courseId] = sections;
      });
    },

    async refreshTags() {
      const tags = await library.listTags();
      set((state) => {
        state.tags = tags;
      });
    },

    async refreshSavedSearches() {
      const savedSearches = await library.listSavedSearches();
      set((state) => {
        state.savedSearches = savedSearches;
      });
    },

    async refreshTemplates() {
      const templates = await library.listTemplates();
      set((state) => {
        state.templates = templates;
      });
    },

    async refreshPendingRecoveries() {
      const pendingRecoveries = await library.pendingRecoveries();
      set((state) => {
        state.pendingRecoveries = pendingRecoveries;
      });
    },

    async refreshTasks() {
      const [tasks, taskNoteLinks] = await Promise.all([
        library.listTasks(DEFAULT_TASK_QUERY),
        library.listTaskNoteLinks(),
      ]);
      set((state) => {
        state.tasks = tasks;
        state.taskNoteLinks = taskNoteLinks;
      });
    },

    async refreshNotes(query) {
      const generation = ++noteQueryGeneration;
      const normalized = { ...query, offset: 0 };
      const [notes, totalNotes] = await Promise.all([
        library.queryNotes(normalized),
        library.countNotes(normalized),
      ]);
      if (generation !== noteQueryGeneration) return;
      set((state) => {
        state.notes = notes;
        state.totalNotes = totalNotes;
        state.lastQuery = normalized;
      });
    },

    async appendNotes() {
      const generation = noteQueryGeneration;
      const { notes, totalNotes, lastQuery, loadingMore } = get();
      if (loadingMore || notes.length >= totalNotes) return;
      set((state) => {
        state.loadingMore = true;
      });
      try {
        const page = await library.queryNotes({ ...lastQuery, offset: notes.length });
        if (generation !== noteQueryGeneration) return;
        set((state) => {
          const seen = new Set(state.notes.map((note) => note.id));
          state.notes.push(...page.filter((note) => !seen.has(note.id)));
        });
      } finally {
        if (generation === noteQueryGeneration) {
          set((state) => {
            state.loadingMore = false;
          });
        }
      }
    },

    async refreshCurrentView() {
      await get().refreshNotes(get().lastQuery);
    },
  })),
);
