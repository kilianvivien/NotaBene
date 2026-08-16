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
  NoteMatch,
  NoteSummary,
  NoteTemplate,
  PendingRecovery,
  SavedSearch,
  Section,
  Snapshot,
  SnapshotCause,
  Tag,
  Task,
  TaskNoteLink,
} from '@/lib/schema';

export type { NoteMatch };

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
  /**
   * How the words of `text` combine. `'all'` is the default and what a search
   * box wants — typing another word narrows the list. `'any'` is for retrieval,
   * where the words are a question rather than a filter and requiring all of
   * them returns nothing.
   */
  textMatch?: 'all' | 'any';
}

/** What the Tasks view, the inspector, and the agent's `list_tasks` all ask. */
export interface TaskQuery {
  /** Free text over title and details; empty means "no text constraint". */
  text?: string;
  status?: ('todo' | 'inProgress' | 'done')[];
  /** `null` asks for unfiled tasks, the way `NoteQuery.courseId` does. */
  courseId?: string | null;
  /** `null` asks for top-level tasks only — the list renders children nested. */
  parentId?: string | null;
  /** Tasks linked to this note, by either a manual link or an inline chip. */
  noteId?: string;
  dueBefore?: string;
  /** Default `live`: a task in Trash is not part of the workload. */
  scope?: 'live' | 'trashed' | 'all';
  sort?: 'due' | 'created' | 'updated' | 'priority' | 'manual';
  limit?: number;
  offset?: number;
}

export interface SnapshotRetentionPolicy {
  /** Snapshots newer than this many days are all retained. */
  keepAllDays: number;
  /** Older snapshots are thinned to one per hour until this age. */
  keepHourlyDays: number;
  /** Then one per day until this age. Older snapshots are kept weekly. */
  keepDailyDays: number;
  /** Disable pruning entirely. */
  forever?: boolean;
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
  /** Count the same filtered query without its limit or offset. */
  countNotes(query: NoteQuery): Promise<number>;
  /**
   * The same query, ranked and scored, ordered by relevance alone — pinning is
   * ignored, because pinning says "keep this handy", not "this answers the
   * question". Requires `text`; a ranked search with nothing to rank throws.
   */
  searchNotes(query: NoteQuery): Promise<NoteMatch[]>;
  getNote(noteId: string): Promise<Note | null>;
  upsertNote(note: Note): Promise<void>;
  /** Atomic optimistic write for interactive/editor and MCP updates. */
  upsertNoteIfUnchanged(note: Note, baseUpdatedAt: string): Promise<boolean>;
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
  createSnapshot(noteId: string, cause: SnapshotCause, runId?: string): Promise<Snapshot>;
  /** Applies the retention policy (hourly → daily → weekly thinning). */
  pruneSnapshots(noteId: string, policy: SnapshotRetentionPolicy): Promise<void>;

  /** Permanently remove every trashed note older than the ISO cutoff. */
  purgeTrash(trashedBefore: string): Promise<number>;

  listAttachments(noteId: string): Promise<Attachment[]>;
  upsertAttachment(attachment: Attachment): Promise<void>;
  deleteAttachment(attachmentId: string): Promise<void>;
  /** Asset rows only; bytes live behind `AssetAdapter`. */
  listAssets(): Promise<Asset[]>;

  listSavedSearches(): Promise<SavedSearch[]>;
  upsertSavedSearch(search: SavedSearch): Promise<void>;
  deleteSavedSearch(searchId: string): Promise<void>;

  listTasks(query: TaskQuery): Promise<Task[]>;
  getTask(taskId: string): Promise<Task | null>;
  /** Ranked free-text search, for the title bar's command search. */
  searchTasks(text: string, limit: number): Promise<Task[]>;
  upsertTask(task: Task): Promise<void>;
  /** Atomic optimistic write, for editor and MCP updates. */
  upsertTaskIfUnchanged(task: Task, baseUpdatedAt: string): Promise<boolean>;
  /** Soft delete, cascading to subtasks. Hard removal is `purgeTrashedTasks`. */
  trashTasks(taskIds: string[]): Promise<void>;
  restoreTasks(taskIds: string[]): Promise<void>;
  purgeTrashedTasks(trashedBefore: string): Promise<number>;
  /**
   * Tasks whose reminder has come due and has not been delivered. The sweep on
   * launch is the same query as the sweep thirty seconds later, which is what
   * makes a reminder missed while the app was closed arrive exactly once.
   */
  listDueReminders(): Promise<Task[]>;
  listTaskNoteLinks(): Promise<TaskNoteLink[]>;
  /** Replaces one task's `manual` links; inline `mention` rows are untouched. */
  setTaskNoteLinks(taskId: string, noteIds: string[]): Promise<void>;

  listTemplates(): Promise<NoteTemplate[]>;
  upsertTemplate(template: NoteTemplate): Promise<void>;
  deleteTemplate(templateId: string): Promise<void>;

  /** Whole-library read for backup/export. Never includes secrets. */
  exportLibrary(): Promise<Library>;
  /** Replace or merge a validated library. Callers must have run
   * `safeImportLibrary` first — this method trusts its input. */
  importLibrary(library: Library, mode: 'replace' | 'merge'): Promise<void>;
}
