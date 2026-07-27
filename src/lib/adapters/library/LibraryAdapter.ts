/**
 * Persistence boundary for the note library.
 *
 * App and editor code never talks to SQLite, Dexie, or `invoke` directly — it
 * talks to this interface. The desktop build backs it with the Rust/SQLite
 * store; a future web build can back it with Dexie/OPFS without any caller
 * changing (PRD §7.2).
 *
 * Every method is async even where an implementation could answer
 * synchronously, so swapping in a slower backend is never a signature change.
 */
import type {
  Attachment,
  Asset,
  Backlink,
  Course,
  JournalEntry,
  Library,
  Note,
  NoteSummary,
  NoteTemplate,
  PendingRecovery,
  SavedSearch,
  Section,
  Snapshot,
  SnapshotCause,
  Tag,
} from '@/lib/schema';

/** Parsed form of the search box. See `src/lib/search/query.ts`. */
export interface NoteQuery {
  /** Free text; empty means "no text constraint". */
  text?: string;
  courseId?: string | null;
  sectionId?: string | null;
  tagIds?: string[];
  /** `has:image`, `has:drawing`, `has:table`, `has:attachment`. */
  has?: ('image' | 'drawing' | 'table' | 'attachment')[];
  createdAfter?: string;
  createdBefore?: string;
  pinned?: boolean;
  /** Default `live`: archived and trashed notes stay out of ordinary views. */
  scope?: 'live' | 'archived' | 'trashed' | 'all';
  sort?: 'updated' | 'created' | 'title' | 'manual' | 'relevance';
  limit?: number;
  offset?: number;
}

export interface LibraryAdapter {
  /** Open the store and run pending migrations. Safe to call more than once. */
  init(): Promise<void>;

  listCourses(): Promise<Course[]>;
  upsertCourse(course: Course): Promise<void>;
  deleteCourse(courseId: string): Promise<void>;

  listSections(courseId: string): Promise<Section[]>;
  upsertSection(section: Section): Promise<void>;
  deleteSection(sectionId: string): Promise<void>;

  /** Summaries only — the note list must never pay for full documents. */
  queryNotes(query: NoteQuery): Promise<NoteSummary[]>;
  getNote(noteId: string): Promise<Note | null>;
  upsertNote(note: Note): Promise<void>;
  /** Soft delete: sets `trashedAt`. Hard removal is `purgeNote`. */
  trashNote(noteId: string): Promise<void>;
  restoreNote(noteId: string): Promise<void>;
  purgeNote(noteId: string): Promise<void>;
  /** Notes whose id-backed wiki links point at this note. */
  listBacklinks(noteId: string): Promise<Backlink[]>;

  /**
   * Crash recovery. The editor writes in-flight state here on every keystroke
   * batch, well ahead of the debounced save; `upsertNote` retires the row in
   * the same transaction as the save it supersedes.
   */
  writeJournal(entry: JournalEntry): Promise<void>;
  /** Journal rows newer than the note they belong to — offered back at launch. */
  pendingRecoveries(): Promise<PendingRecovery[]>;
  discardJournal(noteId: string): Promise<void>;

  listTags(): Promise<Tag[]>;
  upsertTag(tag: Tag): Promise<void>;
  deleteTag(tagId: string): Promise<void>;
  /** Rewrites every note referencing `fromTagId` to point at `intoTagId`. */
  mergeTags(fromTagId: string, intoTagId: string): Promise<void>;

  listSnapshots(noteId: string): Promise<Omit<Snapshot, 'doc'>[]>;
  getSnapshot(snapshotId: string): Promise<Snapshot | null>;
  createSnapshot(noteId: string, cause: SnapshotCause): Promise<Snapshot>;
  /** Applies the retention policy (hourly → daily → weekly thinning). */
  pruneSnapshots(noteId: string): Promise<void>;

  listAttachments(noteId: string): Promise<Attachment[]>;
  upsertAttachment(attachment: Attachment): Promise<void>;
  deleteAttachment(attachmentId: string): Promise<void>;
  /** Asset rows only; bytes live behind `AssetAdapter`. */
  listAssets(): Promise<Asset[]>;

  listSavedSearches(): Promise<SavedSearch[]>;
  upsertSavedSearch(search: SavedSearch): Promise<void>;
  deleteSavedSearch(searchId: string): Promise<void>;

  listTemplates(): Promise<NoteTemplate[]>;
  upsertTemplate(template: NoteTemplate): Promise<void>;
  deleteTemplate(templateId: string): Promise<void>;

  /** Whole-library read for backup/export. Never includes secrets. */
  exportLibrary(): Promise<Library>;
  /** Replace or merge a validated library. Callers must have run
   * `safeImportLibrary` first — this method trusts its input. */
  importLibrary(library: Library, mode: 'replace' | 'merge'): Promise<void>;
}
