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
  type Backlink,
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
import { retainedSnapshotIds } from '@/lib/history/retention';
import { fold } from '@/lib/search/fold';
import { bm25Rank, BM25_WEIGHTS, type RankedFields } from './memoryRanking';
import type {
  LibraryAdapter,
  NoteMatch,
  NoteQuery,
  SnapshotRetentionPolicy,
} from './LibraryAdapter';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function snippetFor(note: Note): string {
  return note.plainText.slice(0, 200);
}

function highlightedSnippet(note: Note, text: string): string {
  const terms = text.trim().split(/\s+/).filter(Boolean);
  const folded = fold(note.plainText);
  const first = terms.map(fold).find((term) => folded.includes(term));
  if (!first) return snippetFor(note);
  const start = Math.max(0, folded.indexOf(first) - 55);
  const raw = note.plainText.slice(start, start + 200);
  const index = fold(raw).indexOf(first);
  if (index < 0) return raw;
  return `${start > 0 ? '… ' : ''}${raw.slice(0, index)}<mark>${raw.slice(index, index + first.length)}</mark>${raw.slice(index + first.length)}`;
}

function toSummary(note: Note, text?: string): NoteSummary {
  const { doc: _doc, plainText: _plainText, ...rest } = note;
  return {
    ...clone(rest),
    snippet: text ? highlightedSnippet(note, text) : snippetFor(note),
  };
}

function wikiTargets(note: Note): { noteId: string | null; title: string }[] {
  const targets: { noteId: string | null; title: string }[] = [];
  function visit(node: Note['doc'] | NonNullable<Note['doc']['content']>[number]) {
    if (node.type === 'wikiLink') {
      const title = typeof node.attrs?.title === 'string' ? node.attrs.title.trim() : '';
      if (title) {
        targets.push({
          noteId: typeof node.attrs?.noteId === 'string' ? node.attrs.noteId : null,
          title,
        });
      }
    }
    node.content?.forEach(visit);
  }
  visit(note.doc);
  return targets;
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
    this.library.sections = this.library.sections.filter(
      (entry) => entry.id !== sectionId,
    );
    for (const note of this.library.notes) {
      if (note.sectionId === sectionId) note.sectionId = null;
    }
  }

  // -- notes ---------------------------------------------------------------

  /** The five columns `notes_fts` indexes, in schema order. */
  private indexedFields(note: Note): RankedFields {
    const course = this.library.courses.find((entry) => entry.id === note.courseId);
    const tagText = this.library.tags
      .filter((entry) => note.tagIds.includes(entry.id))
      .map((entry) => `${entry.namespace ? `${entry.namespace}:` : ''}${entry.name}`)
      .join(' ');
    const attachmentText = this.attachments
      .filter((entry) => entry.noteId === note.id)
      .map((entry) => entry.name)
      .join(' ');
    return [note.title, note.plainText, course?.name ?? '', tagText, attachmentText];
  }

  /** Everything a query constrains except the free text. */
  private matchesFilters(note: Note, query: NoteQuery): boolean {
    const scope = query.scope ?? 'live';
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
    return true;
  }

  async queryNotes(query: NoteQuery): Promise<NoteSummary[]> {
    const text = query.text?.trim();
    const foldedText = text ? fold(text) : '';
    const any = query.textMatch === 'any';

    let rows = this.library.notes.filter((note) => {
      if (!this.matchesFilters(note, query)) return false;
      if (foldedText) {
        const haystack = fold(this.indexedFields(note).join('\n'));
        const terms = foldedText.split(/\s+/);
        const hit = (term: string) => haystack.includes(term);
        if (!(any ? terms.some(hit) : terms.every(hit))) return false;
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
    return rows.slice(offset, offset + limit).map((note) => toSummary(note, text));
  }

  async searchNotes(query: NoteQuery): Promise<NoteMatch[]> {
    const text = query.text?.trim();
    if (!text) {
      // Same refusal as the SQL path: a ranked search with nothing to rank
      // would return the whole library in arbitrary order.
      throw new Error('SEARCH_REQUIRES_TEXT: a ranked search needs something to rank');
    }

    const candidates = this.library.notes.filter((note) =>
      this.matchesFilters(note, query),
    );
    const scores = bm25Rank(
      candidates.map((note) => ({ id: note.id, fields: this.indexedFields(note) })),
      text.split(/\s+/).filter(Boolean),
      BM25_WEIGHTS,
    );

    // Ranked by score alone — pinning deliberately does not lift a note here.
    const ranked = candidates
      .filter((note) => (scores.get(note.id) ?? 0) > 0)
      .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));

    const offset = query.offset ?? 0;
    const limit = query.limit ?? ranked.length;
    return ranked.slice(offset, offset + limit).map((note) => ({
      note: toSummary(note),
      score: scores.get(note.id) ?? 0,
    }));
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

  async listBacklinks(noteId: string): Promise<Backlink[]> {
    const target = this.library.notes.find((note) => note.id === noteId);
    if (!target) return [];
    return this.library.notes
      .filter(
        (note) =>
          !note.trashedAt &&
          wikiTargets(note).some(
            (link) =>
              link.noteId === noteId ||
              (link.noteId === null && fold(link.title) === fold(target.title)),
          ),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((note) => ({
        sourceId: note.id,
        sourceTitle: note.title,
        snippet: snippetFor(note),
        updatedAt: note.updatedAt,
      }));
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
      pending.push({
        ...clone(entry),
        noteTitle: note.title,
        noteUpdatedAt: note.updatedAt,
      });
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
      note.tagIds = [
        ...new Set(note.tagIds.map((id) => (id === fromTagId ? intoTagId : id))),
      ];
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

  async pruneSnapshots(
    noteId: string,
    policy: SnapshotRetentionPolicy,
  ): Promise<void> {
    const candidates = this.library.snapshots.filter((entry) => entry.noteId === noteId);
    const retained = retainedSnapshotIds(candidates, policy);
    this.library.snapshots = this.library.snapshots.filter(
      (entry) => entry.noteId !== noteId || retained.has(entry.id),
    );
  }

  async purgeTrash(trashedBefore: string): Promise<number> {
    const ids = this.library.notes
      .filter((note) => note.trashedAt && note.trashedAt <= trashedBefore)
      .map((note) => note.id);
    for (const id of ids) await this.purgeNote(id);
    return ids.length;
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
    for (const asset of library.assets) {
      const index = this.library.assets.findIndex((entry) => entry.id === asset.id);
      if (index >= 0) this.library.assets[index] = clone(asset);
      else this.library.assets.push(clone(asset));
    }
    for (const snapshot of library.snapshots) {
      const index = this.library.snapshots.findIndex(
        (entry) => entry.id === snapshot.id,
      );
      if (index >= 0) this.library.snapshots[index] = clone(snapshot);
      else this.library.snapshots.push(clone(snapshot));
    }
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
