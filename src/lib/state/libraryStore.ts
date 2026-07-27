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
import type { NoteQuery } from '@/lib/adapters';
import type { Course, NoteSummary, SavedSearch, Section, Tag } from '@/lib/schema';

interface LibraryState {
  courses: Course[];
  /** Sections by course id; loaded lazily as courses are expanded. */
  sections: Record<string, Section[]>;
  tags: Tag[];
  savedSearches: SavedSearch[];
  notes: NoteSummary[];
  loading: boolean;
  error: string | null;
  /** The query behind `notes`, remembered so anything that mutates a note can
   * refresh the list without knowing which view is on screen. */
  lastQuery: NoteQuery;

  /** Load everything the sidebar needs. Called once at startup. */
  bootstrap(): Promise<void>;
  refreshCourses(): Promise<void>;
  refreshSections(courseId: string): Promise<void>;
  refreshTags(): Promise<void>;
  refreshSavedSearches(): Promise<void>;
  /** Run a note query and remember it as the current view. */
  refreshNotes(query: NoteQuery): Promise<void>;
  /** Re-run the last query. Used after any write, so the list never shows a
   * stale title or snippet. */
  refreshCurrentView(): Promise<void>;
}

const DEFAULT_QUERY: NoteQuery = { scope: 'live', sort: 'updated', limit: 200 };

export const useLibraryStore = create<LibraryState>()(
  immer((set, get) => ({
    courses: [],
    sections: {},
    tags: [],
    savedSearches: [],
    notes: [],
    loading: false,
    error: null,
    lastQuery: DEFAULT_QUERY,

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

    async refreshNotes(query) {
      const notes = await library.queryNotes(query);
      set((state) => {
        state.notes = notes;
        state.lastQuery = query;
      });
    },

    async refreshCurrentView() {
      await get().refreshNotes(get().lastQuery);
    },
  })),
);
