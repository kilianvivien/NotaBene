/**
 * Importing a library from another app — a Markdown folder, an Obsidian vault,
 * a Notion export.
 *
 * Three steps, split the way document import is split: `scanSourceCommand`
 * reads and writes nothing, `planSourceImportCommand` decides everything and
 * writes nothing, and only `applySourceImportCommand` touches the library —
 * courses, tags, images and notes, in that order, refreshing the read caches
 * once at the end. The preview the student approves is the plan that runs.
 *
 * No MCP tool reaches any of this. An import reads the student's disk, and
 * that is a decision for the student in a dialog, not for an agent.
 */
import { dialog, folderImporter, library } from '@/lib/adapters';
import {
  planSourceImport,
  SOURCE_IMPORTERS,
  SourceRefusal,
  type ExistingPolicy,
  type ImportPlan,
  type PlannedNote,
  type ScanOptions,
  type SourceId,
  type SourceScan,
} from '@/lib/import/sources';
import { flattenDoc } from '@/lib/notes/docText';
import type { Course, DocNode, Note, NoteDoc, Section } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { storeImageCommand } from './assetCommands';
import { createNotesCommand, type BatchNoteInput } from './noteCommands';
import {
  createCourseCommand,
  createSectionCommand,
  ensureTagsCommand,
  tagKey,
} from './organizationCommands';
import {
  cancelledIfRequested,
  fail,
  ok,
  USER,
  type CommandContext,
  type CommandResult,
} from './types';

export function sourceAvailable(sourceId: SourceId): boolean {
  return SOURCE_IMPORTERS[sourceId].available();
}

/** Ask for the folder or file a source reads. `null` when the student
 * cancelled the panel, which is not a failure. */
export async function pickSourceCommand(
  sourceId: SourceId,
): Promise<CommandResult<string | null>> {
  const importer = SOURCE_IMPORTERS[sourceId];
  if (!importer.available()) return fail('not_supported', 'unavailable');
  try {
    if (importer.root === 'folder') return ok(await folderImporter.pickFolder());
    if (importer.root === 'file') {
      const [path] = await dialog.openFile({
        multiple: false,
        filters: importer.filters,
      });
      return ok(path ?? null);
    }
    return ok(null);
  } catch (error) {
    return fail('not_supported', String(error));
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function scanSourceCommand(
  sourceId: SourceId,
  root: string | null,
  options: ScanOptions = {},
): Promise<CommandResult<SourceScan>> {
  try {
    return ok(await SOURCE_IMPORTERS[sourceId].scan(root, options));
  } catch (error) {
    if (isAbort(error)) return fail('cancelled', 'cancelled');
    if (error instanceof SourceRefusal) return fail('not_supported', error.code);
    const message = error instanceof Error ? error.message : String(error);
    // The folder reader's own codes, from `folder_import.rs`.
    for (const code of [
      'not_picked',
      'too_large',
      'outside_root',
      'not_found',
    ] as const) {
      if (message.startsWith(`${code}:`)) return fail('invalid_input', code, message);
    }
    return fail('invalid_input', 'scan_failed', message);
  }
}

/** Read what the library already holds, then plan. The planning itself is the
 * pure `planSourceImport`; this is only its two reads. */
export async function planSourceImportCommand(
  scan: SourceScan,
  sourceId: SourceId,
  existing: ExistingPolicy,
): Promise<CommandResult<ImportPlan>> {
  try {
    const [imported, titles] = await Promise.all([
      library.listImportedNotes(`${sourceId}:`),
      library.listNoteTitles(),
    ]);
    return ok(planSourceImport(scan, { sourceId, imported, titles, existing }));
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

/** Where imported notes go. */
export type ImportMapping =
  /** Nowhere in particular — the inbox. */
  | { kind: 'inbox' }
  /** Each outermost folder a course, the next level a section. */
  | { kind: 'folders' }
  /** One course (an existing one, or a new one named after the source), with
   * the outermost folders as its sections. */
  | { kind: 'course'; courseId: string | null };

export interface ApplyImportOptions {
  mapping: ImportMapping;
  /** Carry the source's tags (frontmatter, `#tags`, authors, sources). */
  keepTags: boolean;
  onProgress?(progress: { phase: 'images' | 'notes'; done: number; total: number }): void;
}

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  images: number;
  imagesFailed: number;
  coursesCreated: number;
  /** The course the notes went into, when they all went into one. */
  courseId: string | null;
}

/** Folder names → courses and sections, finding existing ones by name before
 * creating any, so importing twice does not grow a second "Physics". */
class Locations {
  private courses: Course[] = [];
  private sections = new Map<string, Section[]>();
  createdCourses = 0;

  constructor(private readonly context: CommandContext) {}

  async load(): Promise<void> {
    this.courses = await library.listCourses();
  }

  private same(a: string, b: string): boolean {
    return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'accent' }) === 0;
  }

  async course(name: string): Promise<string | null> {
    const found =
      this.courses.find((course) => !course.archived && this.same(course.name, name)) ??
      this.courses.find((course) => this.same(course.name, name));
    if (found) return found.id;
    const created = await createCourseCommand({ name: name.slice(0, 200) }, this.context);
    if (!created.ok) return null;
    this.courses.push(created.value);
    this.createdCourses += 1;
    return created.value.id;
  }

  async section(courseId: string, name: string): Promise<string | null> {
    let list = this.sections.get(courseId);
    if (!list) {
      list = await library.listSections(courseId);
      this.sections.set(courseId, list);
    }
    const found = list.find((section) => this.same(section.name, name));
    if (found) return found.id;
    const created = await createSectionCommand(
      { courseId, name: name.slice(0, 200) },
      this.context,
    );
    if (!created.ok) return null;
    list.push(created.value);
    return created.value.id;
  }
}

/** Point every placeholder image at its stored asset, or reduce it to its
 * caption when the picture could not be stored — a broken image in a note is
 * worse than the words that described it. */
function withAssets(
  doc: NoteDoc,
  note: PlannedNote,
  stored: Map<string, string>,
): NoteDoc {
  const visit = (node: DocNode): DocNode[] => {
    if (node.type === 'image' && typeof node.attrs?.assetId === 'string') {
      const attachment = note.source.attachments.get(node.attrs.assetId);
      if (attachment) {
        const assetId = stored.get(attachment.key);
        if (assetId) return [{ ...node, attrs: { ...node.attrs, assetId } }];
        const caption = String(node.attrs.caption ?? node.attrs.alt ?? '').trim();
        return caption
          ? [{ type: 'paragraph', content: [{ type: 'text', text: caption }] }]
          : [];
      }
    }
    return node.content ? [{ ...node, content: node.content.flatMap(visit) }] : [node];
  };
  return { ...doc, content: doc.content.flatMap(visit) };
}

export async function applySourceImportCommand(
  plan: ImportPlan,
  options: ApplyImportOptions,
  context: CommandContext = USER,
): Promise<CommandResult<ImportSummary>> {
  const cancelled = cancelledIfRequested<ImportSummary>(context);
  if (cancelled) return cancelled;
  const writing = plan.notes.filter((note) => note.action !== 'skip');
  const summary: ImportSummary = {
    created: 0,
    updated: 0,
    skipped: plan.notes.length - writing.length,
    images: 0,
    imagesFailed: 0,
    coursesCreated: 0,
    courseId: null,
  };
  if (!writing.length) return ok(summary);

  // An open note about to be updated must not have typing in flight.
  await useEditorStore.getState().flush();

  // 1. Where each new note goes.
  const locations = new Locations(context);
  await locations.load();
  const placement = new Map<
    PlannedNote,
    { courseId: string | null; sectionId: string | null }
  >();
  let singleCourse: string | null = null;
  if (options.mapping.kind === 'course') {
    singleCourse = options.mapping.courseId ?? (await locations.course(plan.label));
    if (!singleCourse) return fail('storage_failed', 'could not create the course');
  }
  for (const note of writing) {
    if (note.action !== 'create') continue;
    const [first, second] = note.source.folders;
    if (options.mapping.kind === 'inbox') {
      placement.set(note, { courseId: null, sectionId: null });
    } else if (options.mapping.kind === 'course' && singleCourse) {
      placement.set(note, {
        courseId: singleCourse,
        sectionId: first ? await locations.section(singleCourse, first) : null,
      });
    } else if (first) {
      const courseId = await locations.course(first);
      placement.set(note, {
        courseId,
        sectionId: courseId && second ? await locations.section(courseId, second) : null,
      });
    } else {
      placement.set(note, { courseId: null, sectionId: null });
    }
  }
  summary.coursesCreated = locations.createdCourses;
  summary.courseId = singleCourse;

  // 2. Tags, in one pass.
  let tagIds = new Map<string, string>();
  if (options.keepTags && plan.tags.length) {
    const ensured = await ensureTagsCommand(
      plan.tags.map((tag) => ({ namespace: tag.namespace, name: tag.name })),
      context,
    );
    if (!ensured.ok) return ensured;
    tagIds = ensured.value;
  }
  const tagsFor = (note: PlannedNote): string[] =>
    options.keepTags
      ? [
          ...new Set(
            note.source.tags
              .map((tag) => tagIds.get(tagKey(tag.namespace, tag.name)))
              .filter((id): id is string => Boolean(id)),
          ),
        ]
      : [];

  // 3. Images, each stored once however many notes use it.
  const attachments = new Map<string, { load(): Promise<Blob> }>();
  for (const note of writing) {
    for (const attachment of note.source.attachments.values()) {
      attachments.set(attachment.key, attachment);
    }
  }
  const stored = new Map<string, string>();
  let done = 0;
  for (const [key, attachment] of attachments) {
    const stopped = cancelledIfRequested<ImportSummary>(context);
    if (stopped) return stopped;
    try {
      const result = await storeImageCommand(await attachment.load());
      if (result.ok) stored.set(key, result.value.id);
      else summary.imagesFailed += 1;
    } catch {
      // One unreadable picture must not cost the vault its notes.
      summary.imagesFailed += 1;
    }
    done += 1;
    options.onProgress?.({ phase: 'images', done, total: attachments.size });
  }
  summary.images = stored.size;

  // 4. New notes, in one batch: links between them already carry their ids.
  const now = new Date().toISOString();
  const creates: BatchNoteInput[] = writing
    .filter((note) => note.action === 'create')
    .map((note) => {
      const location = placement.get(note) ?? { courseId: null, sectionId: null };
      // A file dated in the future would read as "edited since import" forever.
      const updatedAt =
        note.source.updatedAt && note.source.updatedAt < now
          ? note.source.updatedAt
          : now;
      const createdAt =
        note.source.createdAt && note.source.createdAt <= updatedAt
          ? note.source.createdAt
          : updatedAt;
      return {
        id: note.noteId,
        title: note.title.slice(0, 500),
        doc: withAssets(note.doc, note, stored),
        courseId: location.courseId,
        sectionId: location.sectionId,
        tagIds: tagsFor(note),
        importKey: note.importKey,
        importedAt: now,
        createdAt,
        updatedAt,
      };
    });
  options.onProgress?.({ phase: 'notes', done: 0, total: writing.length });
  if (creates.length) {
    const created = await createNotesCommand(creates, context);
    if (!created.ok) return created;
    summary.created = created.value.length;
  }

  // 5. Notes imported before and changed since: the current version goes into
  // history first, as a re-import rather than an anonymous save.
  const updates: Note[] = [];
  for (const note of writing) {
    if (note.action !== 'update') continue;
    const existing = await library.getNote(note.noteId);
    if (!existing) continue;
    try {
      await library.createSnapshot(existing.id, 'import', context.agentRunId);
    } catch {
      // As in `applyNoteUpdate`: a lost undo point must not block the write.
    }
    const doc = withAssets(note.doc, note, stored);
    updates.push({
      ...existing,
      doc,
      plainText: flattenDoc(doc),
      tagIds: [...new Set([...existing.tagIds, ...tagsFor(note)])],
      importedAt: now,
      updatedAt: now,
    });
  }
  try {
    for (let start = 0; start < updates.length; start += 250) {
      await library.upsertNotes(updates.slice(start, start + 250));
      summary.updated += Math.min(250, updates.length - start);
    }
  } catch (error) {
    return fail('storage_failed', String(error), {
      written: summary.created + summary.updated,
    });
  }
  options.onProgress?.({ phase: 'notes', done: writing.length, total: writing.length });

  const store = useLibraryStore.getState();
  await Promise.all([store.refreshCourses(), store.refreshCurrentView()]).catch(() => {});
  const editor = useEditorStore.getState();
  if (editor.note && updates.some((note) => note.id === editor.note?.id)) {
    await editor.openNote(editor.note.id);
  }
  return ok(summary);
}
