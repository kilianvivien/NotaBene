/**
 * SQLite-backed library store, via the Rust side.
 *
 * Every method is a thin `invoke` into a `library_*` Tauri command; the schema,
 * migrations, FTS5 index, and WAL crash-safety all live in `src-tauri/src/db/`.
 * Keeping this file dumb is the point — if a query needs to be clever, the
 * cleverness belongs in SQL where it can use the indexes.
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  Attachment,
  Asset,
  Backlink,
  Course,
  JournalEntry,
  Library,
  Note,
  NoteMatch,
  NoteSummary,
  NoteTemplate,
  PendingRecovery,
  SavedSearch,
  Section,
  Snapshot,
  SnapshotCause,
  Tag,
} from '@/lib/schema';
import type {
  LibraryAdapter,
  NoteQuery,
  SnapshotRetentionPolicy,
} from './LibraryAdapter';

export const tauriLibraryAdapter: LibraryAdapter = {
  init: () => invoke('library_init'),

  listCourses: () => invoke('library_list_courses'),
  upsertCourse: (course: Course) => invoke('library_upsert_course', { course }),
  deleteCourse: (courseId: string) => invoke('library_delete_course', { courseId }),

  listSections: (courseId: string) => invoke('library_list_sections', { courseId }),
  upsertSection: (section: Section) => invoke('library_upsert_section', { section }),
  deleteSection: (sectionId: string) => invoke('library_delete_section', { sectionId }),

  queryNotes: (query: NoteQuery): Promise<NoteSummary[]> =>
    invoke('library_query_notes', { query }),
  searchNotes: (query: NoteQuery): Promise<NoteMatch[]> =>
    invoke('library_search_notes', { query }),
  getNote: (noteId: string): Promise<Note | null> =>
    invoke('library_get_note', { noteId }),
  upsertNote: (note: Note) => invoke('library_upsert_note', { note }),
  trashNote: (noteId: string) => invoke('library_trash_note', { noteId }),
  restoreNote: (noteId: string) => invoke('library_restore_note', { noteId }),
  purgeNote: (noteId: string) => invoke('library_purge_note', { noteId }),
  listBacklinks: (noteId: string): Promise<Backlink[]> =>
    invoke('library_list_backlinks', { noteId }),

  writeJournal: (entry: JournalEntry) => invoke('journal_write', { entry }),
  pendingRecoveries: (): Promise<PendingRecovery[]> => invoke('journal_pending'),
  discardJournal: (noteId: string) => invoke('journal_discard', { noteId }),

  listTags: (): Promise<Tag[]> => invoke('library_list_tags'),
  upsertTag: (tag: Tag) => invoke('library_upsert_tag', { tag }),
  deleteTag: (tagId: string) => invoke('library_delete_tag', { tagId }),
  mergeTags: (fromTagId: string, intoTagId: string) =>
    invoke('library_merge_tags', { fromTagId, intoTagId }),

  listSnapshots: (noteId: string): Promise<Omit<Snapshot, 'doc'>[]> =>
    invoke('library_list_snapshots', { noteId }),
  getSnapshot: (snapshotId: string): Promise<Snapshot | null> =>
    invoke('library_get_snapshot', { snapshotId }),
  createSnapshot: (noteId: string, cause: SnapshotCause): Promise<Snapshot> =>
    invoke('library_create_snapshot', { noteId, cause }),
  pruneSnapshots: (noteId: string, policy: SnapshotRetentionPolicy) =>
    invoke('library_prune_snapshots', { noteId, policy }),
  purgeTrash: (trashedBefore: string) =>
    invoke<number>('library_purge_trash', { trashedBefore }),

  listAttachments: (noteId: string): Promise<Attachment[]> =>
    invoke('library_list_attachments', { noteId }),
  upsertAttachment: (attachment: Attachment) =>
    invoke('library_upsert_attachment', { attachment }),
  deleteAttachment: (attachmentId: string) =>
    invoke('library_delete_attachment', { attachmentId }),
  listAssets: (): Promise<Asset[]> => invoke('library_list_assets'),

  listSavedSearches: (): Promise<SavedSearch[]> => invoke('library_list_saved_searches'),
  upsertSavedSearch: (search: SavedSearch) =>
    invoke('library_upsert_saved_search', { search }),
  deleteSavedSearch: (searchId: string) =>
    invoke('library_delete_saved_search', { searchId }),

  listTemplates: (): Promise<NoteTemplate[]> => invoke('library_list_templates'),
  upsertTemplate: (template: NoteTemplate) =>
    invoke('library_upsert_template', { template }),
  deleteTemplate: (templateId: string) =>
    invoke('library_delete_template', { templateId }),

  exportLibrary: (): Promise<Library> => invoke('library_export'),
  importLibrary: (library: Library, mode: 'replace' | 'merge') =>
    invoke('library_import', { library, mode }),
};
