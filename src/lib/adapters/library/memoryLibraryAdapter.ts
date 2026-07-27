/**
 * In-memory library store.
 *
 * Two jobs: it is the store unit tests run against, and it is what backs
 * `pnpm dev` in a plain browser so UI work does not require a Tauri build. It
 * implements the full contract — including query filtering and snapshot
 * ordering — so a test passing here means the interface is honoured, not that
 * the fake was lenient. It is deliberately *not* persistent; the desktop build
 * uses `tauriLibraryAdapter`.
 */
import {
  createNote,
  emptyLibrary,
  newId,
  type Attachment,
  type Asset,
  type Course,
  type JournalEntry,
  type Library,
  type Note,
  type NoteSummary,
  type NoteTemplate,
  type PendingRecovery,
  type SavedSearch,
  type Section,
  type Snapshot,
  type SnapshotCause,
  type Tag,
} from '@/lib/schema';
import { flattenDoc, docHasFeature } from '@/lib/notes/docText';
import type { LibraryAdapter, NoteQuery } from './LibraryAdapter';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function snippetFor(note: Note): string {
  return note.plainText.slice(0, 200);
}

function toSummary(note: Note): NoteSummary {
  const { doc: _doc, plainText: _plainText, ...rest } = note;
  return { ...clone(rest), snippet: snippetFor(note) };
}

class MemoryLibraryAdapter implements LibraryAdapter {
  private library: Library = emptyLibrary();
  private attachments: Attachment[] = [];
  private journal = new Map<string, JournalEntry>();

  async init(): Promise<void> {}

  // -- courses & sections --------------------------------------------------

  async listCourses(): Promise<Course[]> {
    return clone(this.library.courses).sort((a, b) => a.order - b.order);
  }

  async upsertCourse(course: Course): Promise<void> {
    const index = this.library.courses.findIndex((entry) => entry.id === course.id);
    if (index >= 0) this.library.courses[index] = clone(course);
    else this.library.courses.push(clone(course));
  }

  async deleteCourse(courseId: string): Promise<void> {
    this.library.courses = this.library.courses.filter((entry) => entry.id !== courseId);
    this.library.sections = this.library.sections.filter(
      (entry) => entry.courseId !== courseId,
    );
    // Notes survive their course — they fall back to the inbox rather than
    // vanishing with it.
    for (const note of this.library.notes) {
      if (note.courseId === courseId) {
        note.courseId = null;
        note.sectionId = null;
      }
    }
  }

  async listSections(courseId: string): Promise<Section[]> {
    return clone(this.library.sections)
      .filter((entry) => entry.courseId === courseId)
      .sort((a, b) => a.order - b.order);
  }

  async upsertSection(section: Section): Promise<void> {
    const index = this.library.sections.findIndex((entry) => entry.id === section.id);
    if (index >= 0) this.library.sections[index] = clone(section);
    else this.library.sections.push(clone(section));
  }

  async deleteSection(sectionId: string): Promise<void> {
    this.library.sections = this.library.sections.filter((entry) => entry.id !== sectionId);
    for (const note of this.library.notes) {
      if (note.sectionId === sectionId) note.sectionId = null;
    }
  }

  // -- notes ---------------------------------------------------------------

  async queryNotes(query: NoteQuery): Promise<NoteSummary[]> {
    const scope = query.scope ?? 'live';
    const text = query.text?.trim().toLowerCase();

    let rows = this.library.notes.filter((note) => {
      if (scope === 'live' && (note.archived || note.trashedAt)) return false;
      if (scope === 'archived' && (!note.archived || note.trashedAt)) return false;
      if (scope === 'trashed' && !note.trashedAt) return false;
      if (query.courseId !== undefined && note.courseId !== query.courseId) return false;
      if (query.sectionId !== undefined && note.sectionId !== query.sectionId) return false;
      if (query.pinned !== undefined && note.pinned !== query.pinned) return false;
      if (query.tagIds?.length && !query.tagIds.every((id) => note.tagIds.includes(id))) {
        return false;
      }
      if (query.createdAfter && note.createdAt < query.createdAfter) return false;
      if (query.createdBefore && note.createdAt > query.createdBefore) return false;
      if (query.has?.length) {
        const satisfied = query.has.every((feature) =>
          feature === 'attachment'
            ? this.attachments.some((entry) => entry.noteId === note.id)
            : docHasFeature(note.doc, feature),
        );
        if (!satisfied) return false;
      }
      if (text) {
        const haystack = `${note.title}\n${note.plainText}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });

    const sort = query.sort ?? 'updated';
    rows = [...rows].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      switch (sort) {
        case 'created':
          return b.createdAt.localeCompare(a.createdAt);
        case 'title':
          return a.title.localeCompare(b.title);
        case 'manual':
          return a.order - b.order;
        default:
          return b.updatedAt.localeCompare(a.updatedAt);
      }
    });

    const offset = query.offset ?? 0;
    const limit = query.limit ?? rows.length;
    return rows.slice(offset, offset + limit).map(toSummary);
  }

  async getNote(noteId: string): Promise<Note | null> {
    const note = this.library.notes.find((entry) => entry.id === noteId);
    return note ? clone(note) : null;
  }

  async upsertNote(note: Note): Promise<void> {
    const stored = clone(note);
    // Keep the derived field honest even if a caller forgot to recompute it.
    stored.plainText = flattenDoc(stored.doc);
    const index = this.library.notes.findIndex((entry) => entry.id === note.id);
    if (index >= 0) this.library.notes[index] = stored;
    else this.library.notes.push(stored);
    // The note reached the store, so any journalled in-flight copy is stale —
    // the SQLite adapter does this inside the write transaction.
    this.journal.delete(note.id);
  }

  async trashNote(noteId: string): Promise<void> {
    const note = this.library.notes.find((entry) => entry.id === noteId);
    if (note) note.trashedAt = new Date().toISOString();
  }

  async restoreNote(noteId: string): Promise<void> {
    const note = this.library.notes.find((entry) => entry.id === noteId);
    if (note) note.trashedAt = null;
  }

  async purgeNote(noteId: string): Promise<void> {
    this.journal.delete(noteId);
    this.library.notes = this.library.notes.filter((entry) => entry.id !== noteId);
    this.library.snapshots = this.library.snapshots.filter(
      (entry) => entry.noteId !== noteId,
    );
    this.attachments = this.attachments.filter((entry) => entry.noteId !== noteId);
  }

  // -- crash recovery ------------------------------------------------------

  async writeJournal(entry: JournalEntry): Promise<void> {
    this.journal.set(entry.noteId, clone(entry));
  }

  async pendingRecoveries(): Promise<PendingRecovery[]> {
    const pending: PendingRecovery[] = [];
    for (const entry of this.journal.values()) {
      const note = this.library.notes.find((candidate) => candidate.id === entry.noteId);
      if (!note || note.trashedAt) continue;
      if (entry.writtenAt <= note.updatedAt) continue;
      pending.push({ ...clone(entry), noteTitle: note.title, noteUpdatedAt: note.updatedAt });
    }
    return pending.sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));
  }

  async discardJournal(noteId: string): Promise<void> {
    this.journal.delete(noteId);
  }

  // -- tags ----------------------------------------------------------------

  async listTags(): Promise<Tag[]> {
    return clone(this.library.tags);
  }

  async upsertTag(tag: Tag): Promise<void> {
    const index = this.library.tags.findIndex((entry) => entry.id === tag.id);
    if (index >= 0) this.library.tags[index] = clone(tag);
    else this.library.tags.push(clone(tag));
  }

  async deleteTag(tagId: string): Promise<void> {
    this.library.tags = this.library.tags.filter((entry) => entry.id !== tagId);
    for (const note of this.library.notes) {
      note.tagIds = note.tagIds.filter((id) => id !== tagId);
    }
  }

  async mergeTags(fromTagId: string, intoTagId: string): Promise<void> {
    for (const note of this.library.notes) {
      if (!note.tagIds.includes(fromTagId)) continue;
      note.tagIds = [...new Set(note.tagIds.map((id) => (id === fromTagId ? intoTagId : id)))];
    }
    await this.deleteTag(fromTagId);
  }

  // -- snapshots -----------------------------------------------------------

  async listSnapshots(noteId: string): Promise<Omit<Snapshot, 'doc'>[]> {
    return this.library.snapshots
      .filter((entry) => entry.noteId === noteId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ doc: _doc, ...rest }) => clone(rest));
  }

  async getSnapshot(snapshotId: string): Promise<Snapshot | null> {
    const snapshot = this.library.snapshots.find((entry) => entry.id === snapshotId);
    return snapshot ? clone(snapshot) : null;
  }

  async createSnapshot(noteId: string, cause: SnapshotCause): Promise<Snapshot> {
    const note = this.library.notes.find((entry) => entry.id === noteId);
    if (!note) throw new Error(`cannot snapshot unknown note ${noteId}`);
    const snapshot: Snapshot = {
      id: newId(),
      noteId,
      doc: clone(note.doc),
      title: note.title,
      cause,
      createdAt: new Date().toISOString(),
    };
    this.library.snapshots.push(snapshot);
    return clone(snapshot);
  }

  async pruneSnapshots(_noteId: string): Promise<void> {
    // Retention thinning lands with the history browser (Phase D).
  }

  // -- attachments & assets ------------------------------------------------

  async listAttachments(noteId: string): Promise<Attachment[]> {
    return clone(this.attachments.filter((entry) => entry.noteId === noteId));
  }

  async upsertAttachment(attachment: Attachment): Promise<void> {
    const index = this.attachments.findIndex((entry) => entry.id === attachment.id);
    if (index >= 0) this.attachments[index] = clone(attachment);
    else this.attachments.push(clone(attachment));
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    this.attachments = this.attachments.filter((entry) => entry.id !== attachmentId);
  }

  async listAssets(): Promise<Asset[]> {
    return clone(this.library.assets);
  }

  // -- saved searches & templates ------------------------------------------

  async listSavedSearches(): Promise<SavedSearch[]> {
    return clone(this.library.savedSearches);
  }

  async upsertSavedSearch(search: SavedSearch): Promise<void> {
    const index = this.library.savedSearches.findIndex((entry) => entry.id === search.id);
    if (index >= 0) this.library.savedSearches[index] = clone(search);
    else this.library.savedSearches.push(clone(search));
  }

  async deleteSavedSearch(searchId: string): Promise<void> {
    this.library.savedSearches = this.library.savedSearches.filter(
      (entry) => entry.id !== searchId,
    );
  }

  async listTemplates(): Promise<NoteTemplate[]> {
    return clone(this.library.templates);
  }

  async upsertTemplate(template: NoteTemplate): Promise<void> {
    const index = this.library.templates.findIndex((entry) => entry.id === template.id);
    if (index >= 0) this.library.templates[index] = clone(template);
    else this.library.templates.push(clone(template));
  }

  async deleteTemplate(templateId: string): Promise<void> {
    this.library.templates = this.library.templates.filter(
      (entry) => entry.id !== templateId,
    );
  }

  // -- whole-library -------------------------------------------------------

  async exportLibrary(): Promise<Library> {
    return clone({
      ...this.library,
      attachments: this.attachments,
      exportedAt: new Date().toISOString(),
    });
  }

  async importLibrary(library: Library, mode: 'replace' | 'merge'): Promise<void> {
    if (mode === 'replace') {
      this.library = clone(library);
      this.attachments = clone(library.attachments);
      return;
    }
    for (const course of library.courses) await this.upsertCourse(course);
    for (const section of library.sections) await this.upsertSection(section);
    for (const tag of library.tags) await this.upsertTag(tag);
    for (const note of library.notes) await this.upsertNote(note);
    for (const attachment of library.attachments) await this.upsertAttachment(attachment);
    for (const search of library.savedSearches) await this.upsertSavedSearch(search);
    for (const template of library.templates) await this.upsertTemplate(template);
  }

  /** Test seam: wipe everything between test cases. */
  reset(): void {
    this.library = emptyLibrary();
    this.attachments = [];
    this.journal.clear();
  }

  /** Test seam: quickly stock the store without going through commands. */
  seedNote(partial: Parameters<typeof createNote>[0]): Note {
    const note = createNote(partial);
    note.plainText = flattenDoc(note.doc);
    this.library.notes.push(note);
    return clone(note);
  }
}

export const memoryLibraryAdapter = new MemoryLibraryAdapter();
export { MemoryLibraryAdapter };
