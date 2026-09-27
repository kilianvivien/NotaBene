/**
 * What an import would do, decided before anything is written.
 *
 * Pure: it takes a scan and a snapshot of the library and returns a plan, so
 * the preview is exactly what the apply step will do, and every rule here is
 * testable without a store. Four decisions live here, written once for every
 * reader:
 *
 * 1. **Which notes were imported before.** `importKey` is `{source}:{key}`,
 *    so a second import of the same vault finds last week's notes and offers
 *    update, skip or duplicate — never a silent second copy.
 * 2. **Titles stay unique.** A bare `[[Week 4]]` resolves to the first note of
 *    that title (`resolve_wiki_title_in`, `LIMIT 1`), so two imported notes
 *    called "Week 4" — or one colliding with a note already in the library —
 *    would make links land on the wrong one. The shallower note keeps the
 *    title, which is Obsidian's own tie-break; the other gains its folder.
 * 3. **Links get ids before the notes exist.** New notes are given their ids
 *    here, so a link to a note in the same batch carries its id from the
 *    start and never depends on a title lookup at all.
 * 4. **Changed or not.** The note's text is compared, not a stored hash — one
 *    fewer persisted field, and it cannot drift from what the note holds.
 */
import { markdownToDoc } from '@/editor/markdown';
import type { ImportedNoteRef, NoteTitle } from '@/lib/adapters';
import { flattenDoc } from '@/lib/notes/docText';
import { newId as mintId, type ImportWarning, type NoteDoc } from '@/lib/schema';
import { byDepth } from './folderSource';
import { basename, stripExtension } from './markdownNote';
import {
  warn,
  type SourceId,
  type SourceNote,
  type SourceScan,
  type SourceSkip,
  type SourceTag,
} from './SourceImporter';

/** What to do with a note this source imported before. */
export type ExistingPolicy = 'update' | 'skip' | 'duplicate';

export type PlannedStatus = 'new' | 'changed' | 'unchanged';

export interface PlannedNote {
  source: SourceNote;
  importKey: string;
  /** The id the note will have: freshly minted, or the existing note's. */
  noteId: string;
  /** The note an earlier import wrote, if there is one. */
  existingId: string | null;
  title: string;
  /** The title was changed to keep it unique. */
  renamed: boolean;
  status: PlannedStatus;
  action: 'create' | 'update' | 'skip';
  /** The existing note was edited in NotaBene after it was imported, so an
   * update replaces that work (version history keeps it). */
  editedSinceImport: boolean;
  doc: NoteDoc;
  plainText: string;
}

export interface ImportPlan {
  sourceId: SourceId;
  label: string;
  notes: PlannedNote[];
  skipped: SourceSkip[];
  /** The source's own warnings plus every note's, summed per code. */
  warnings: ImportWarning[];
  /** Distinct outermost folders, for the mapping preview. */
  folders: string[];
  tags: SourceTag[];
  counts: {
    new: number;
    changed: number;
    unchanged: number;
    create: number;
    update: number;
    skip: number;
    renamed: number;
    editedSinceImport: number;
    images: number;
  };
}

export interface PlanContext {
  sourceId: SourceId;
  /** What `listImportedNotes('{sourceId}:')` returned. */
  imported: ImportedNoteRef[];
  titles: NoteTitle[];
  existing: ExistingPolicy;
  newId?: () => string;
}

export function importKeyFor(sourceId: SourceId, note: SourceNote): string {
  return `${sourceId}:${note.sourceKey}`;
}

/** Whitespace is not a change: two conversions of the same file may differ in
 * how many blank lines they keep. */
function sameText(a: string, b: string): boolean {
  const normal = (value: string) => value.replace(/\s+/g, ' ').trim();
  return normal(a) === normal(b);
}

function pathKey(path: string): string {
  return stripExtension(path.replace(/^\.?\/+/, '')).toLowerCase();
}

export function planSourceImport(scan: SourceScan, context: PlanContext): ImportPlan {
  const newId = context.newId ?? mintId;

  // The newest live note per key. A trashed import is not "already here":
  // the student threw it away, and bringing it back as new is honest.
  const byKey = new Map<string, ImportedNoteRef>();
  for (const note of context.imported) {
    if (!note.trashedAt && !byKey.has(note.importKey)) byKey.set(note.importKey, note);
  }

  // Titles in the library that a new note must not take. Notes this import
  // keeps (updates or skips) keep their own titles, so they are left out.
  const kept = new Set<string>();
  if (context.existing !== 'duplicate') {
    for (const source of scan.notes) {
      const match = byKey.get(importKeyFor(context.sourceId, source));
      if (match) kept.add(match.id);
    }
  }
  const taken = new Set(
    context.titles
      .filter((note) => !kept.has(note.id))
      .map((note) => note.title.trim().toLowerCase())
      .filter(Boolean),
  );

  const ordered = [...scan.notes].sort((a, b) => byDepth(a.displayPath, b.displayPath));
  const drafts = new Map<
    SourceNote,
    Omit<PlannedNote, 'doc' | 'plainText' | 'status' | 'action' | 'editedSinceImport'> & {
      match: ImportedNoteRef | null;
    }
  >();

  for (const source of ordered) {
    const importKey = importKeyFor(context.sourceId, source);
    const match = byKey.get(importKey) ?? null;
    if (match && context.existing !== 'duplicate') {
      taken.add(match.title.trim().toLowerCase());
      drafts.set(source, {
        source,
        importKey,
        noteId: match.id,
        existingId: match.id,
        title: match.title,
        renamed: false,
        match,
      });
      continue;
    }

    const base = source.title.trim() || 'Untitled';
    let title = base;
    if (taken.has(title.toLowerCase()) && source.folders.length) {
      title = `${base} (${source.folders.join('/')})`;
    }
    for (let suffix = 2; taken.has(title.toLowerCase()); suffix += 1) {
      title = `${base} (${suffix})`;
    }
    taken.add(title.toLowerCase());
    drafts.set(source, {
      source,
      importKey,
      noteId: newId(),
      existingId: match?.id ?? null,
      title,
      renamed: title !== base,
      match: null,
    });
  }

  // Everything a link might call a note, most specific first.
  const byPath = new Map<string, string>();
  const byName = new Map<string, SourceNote[]>();
  const byAlias = new Map<string, SourceNote>();
  const byTitle = new Map<string, SourceNote>();
  for (const source of ordered) {
    byPath.set(pathKey(source.displayPath), source.displayPath);
    const name = stripExtension(basename(source.displayPath)).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), source]);
    for (const alias of source.aliases) {
      if (!byAlias.has(alias.toLowerCase())) byAlias.set(alias.toLowerCase(), source);
    }
    if (!byTitle.has(source.title.toLowerCase()))
      byTitle.set(source.title.toLowerCase(), source);
  }
  const pathOwner = new Map(ordered.map((source) => [source.displayPath, source]));

  const find = (target: string): SourceNote | undefined => {
    const key = pathKey(target);
    const exact = byPath.get(key);
    if (exact) return pathOwner.get(exact);
    const name = key.split('/').pop() ?? key;
    const named = byName.get(name);
    if (named?.length) {
      // `[[Physics/Week 4]]` may be a partial path; prefer a note whose path
      // ends with it, then the shallowest of that name.
      return key.includes('/')
        ? (named.find((source) => pathKey(source.displayPath).endsWith(key)) ?? named[0])
        : named[0];
    }
    return (
      byAlias.get(key) ??
      byAlias.get(target.trim().toLowerCase()) ??
      byTitle.get(target.trim().toLowerCase())
    );
  };

  const resolveWikiLink = (target: string) => {
    const source = find(target);
    const draft = source ? drafts.get(source) : undefined;
    if (draft) return { title: draft.title, noteId: draft.noteId };
    return {
      title: stripExtension(basename(target)).trim() || target.trim(),
      noteId: null,
    };
  };

  const warnings: ImportWarning[] = scan.warnings.map((warning) => ({ ...warning }));
  const folders = new Set<string>();
  const tags: SourceTag[] = [];
  const images = new Set<string>();
  const notes: PlannedNote[] = [];

  for (const source of [...scan.notes].sort((a, b) =>
    a.displayPath.localeCompare(b.displayPath),
  )) {
    const draft = drafts.get(source)!;
    const doc = markdownToDoc(source.markdown, {
      wikiLinks: 'obsidian',
      resolveWikiLink,
    });
    const plainText = flattenDoc(doc);
    const { match, ...rest } = draft;

    let status: PlannedStatus = 'new';
    let action: PlannedNote['action'] = 'create';
    let editedSinceImport = false;
    if (match) {
      status = sameText(plainText, match.plainText) ? 'unchanged' : 'changed';
      editedSinceImport = Boolean(match.importedAt && match.updatedAt > match.importedAt);
      action = context.existing === 'skip' || status === 'unchanged' ? 'skip' : 'update';
    }

    for (const warning of source.warnings) warn(warnings, warning.code, warning.count);
    if (source.folders[0]) folders.add(source.folders[0]);
    for (const tag of source.tags) {
      if (
        !tags.some(
          (entry) =>
            entry.namespace === tag.namespace &&
            entry.name.toLowerCase() === tag.name.toLowerCase(),
        )
      ) {
        tags.push(tag);
      }
    }
    if (action !== 'skip') {
      for (const attachment of source.attachments.values()) images.add(attachment.key);
    }
    notes.push({ ...rest, doc, plainText, status, action, editedSinceImport });
  }

  const count = (predicate: (note: PlannedNote) => boolean) =>
    notes.filter(predicate).length;
  return {
    sourceId: context.sourceId,
    label: scan.label,
    notes,
    skipped: scan.skipped,
    warnings,
    folders: [...folders].sort((a, b) => a.localeCompare(b)),
    tags,
    counts: {
      new: count((note) => note.status === 'new'),
      changed: count((note) => note.status === 'changed'),
      unchanged: count((note) => note.status === 'unchanged'),
      create: count((note) => note.action === 'create'),
      update: count((note) => note.action === 'update'),
      skip: count((note) => note.action === 'skip'),
      renamed: count((note) => note.renamed),
      editedSinceImport: count(
        (note) => note.action === 'update' && note.editedSinceImport,
      ),
      images: images.size,
    },
  };
}
