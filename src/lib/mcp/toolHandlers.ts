/**
 * MCP tool implementations.
 *
 * Each handler validates its own arguments and then delegates to a command —
 * it never reaches for an adapter directly. Note what is *not* here: no purge,
 * empty-Trash, or permanent delete. Recoverable Trash is the hard boundary, so
 * no agent can destroy a student's notes (PRD §5.7).
 */
import { z } from 'zod';
import {
  cancelledIfRequested,
  createNoteCommand,
  createCourseCommand,
  ensureTagCommand,
  exportNotesCommand,
  fail,
  listCoursesCommand,
  listSectionsCommand,
  listTagsCommand,
  ok,
  organizeNotesCommand,
  queryNotesCommand,
  readNoteCommand,
  updateNoteCommand,
  updateTagCommand,
  type CommandContext,
  type CommandResult,
} from '@/lib/commands';
import {
  mergeNotesCommand,
  restoreNotesCommand,
  trashNotesCommand,
} from '@/lib/commands/bulkCommands';
import {
  completeTaskCommand,
  createTaskCommand,
  linkTaskToNoteCommand,
  listTasksCommand,
  restoreTasksCommand,
  trashTasksCommand,
  updateTaskCommand,
} from '@/lib/commands/taskCommands';
import { storage } from '@/lib/adapters';
import { joinPath } from '@/lib/commands/backupCommands';
import {
  NoteDocSchema,
  RECURRENCE_FREQS,
  TAG_NAMESPACES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type AgentToolName,
  type Note,
  type Task,
} from '@/lib/schema';
import { parseQuery, resolveQuery } from '@/lib/search/query';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { docToMarkdown, markdownToDoc } from '@/editor/markdown';

type Handler = (
  args: unknown,
  context: CommandContext,
) => Promise<CommandResult<unknown>>;

const ListNotesArgs = z.object({
  courseId: z.string().optional(),
  scope: z.enum(['live', 'archived', 'trashed']).default('live'),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
});

const VersionedNoteArgs = z.object({
  noteId: z.string().min(1),
  baseUpdatedAt: z.string().datetime(),
});

const VersionedNotesArgs = z.object({
  notes: z.array(VersionedNoteArgs).min(1).max(500),
});

const MergeNotesArgs = VersionedNotesArgs.extend({
  title: z.string().max(500).optional(),
  sourceFate: z.enum(['keep', 'archive', 'trash']).default('keep'),
}).refine((value) => value.notes.length >= 2, {
  message: 'choose at least two notes to merge',
  path: ['notes'],
});

const SearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(200).default(50),
});

const ReadNoteArgs = z.object({
  noteId: z.string().min(1),
  /** `json` gives the document tree; `markdown` gives rendered text. */
  format: z.enum(['json', 'markdown', 'blocks', 'both']).default('both'),
});

const NoteBlockPatchArgs = z
  .object({
    index: z.number().int().nonnegative(),
    action: z.enum(['insert', 'replace', 'remove']),
    markdown: z.string().optional(),
  })
  .superRefine((patch, ctx) => {
    if (patch.action !== 'remove' && !patch.markdown?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['markdown'],
        message: `${patch.action} requires markdown`,
      });
    }
  });

const CreateNoteArgs = z
  .object({
    title: z.string().max(500).optional(),
    courseId: z.string().optional(),
    sectionId: z.string().optional(),
    /** Markdown is the friendlier input for an agent; the server converts. */
    markdown: z.string().optional(),
    /** Structured editor document for lossless callers. */
    doc: NoteDocSchema.optional(),
    /** Copy an existing note without sending its unchanged body through a model. */
    copyFrom: VersionedNoteArgs.optional(),
    /** New Markdown inserted before a copied document. */
    prependMarkdown: z.string().optional(),
    /** New Markdown inserted after a copied document. */
    appendMarkdown: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .refine((value) => value.markdown === undefined || value.doc === undefined, {
    message: 'supply markdown or doc, not both',
  })
  .refine(
    (value) =>
      value.copyFrom === undefined ||
      (value.markdown === undefined && value.doc === undefined),
    { message: 'copyFrom cannot be combined with markdown or doc' },
  )
  .refine(
    (value) =>
      (value.prependMarkdown === undefined && value.appendMarkdown === undefined) ||
      value.copyFrom !== undefined,
    { message: 'prependMarkdown and appendMarkdown require copyFrom' },
  );

const UpdateNoteArgs = z
  .object({
    noteId: z.string().min(1),
    /** Required optimistic-concurrency token returned by read/list/search. */
    baseUpdatedAt: z.string().datetime(),
    title: z.string().max(500).optional(),
    markdown: z.string().optional(),
    doc: NoteDocSchema.optional(),
    /** New Markdown inserted before the existing document without replacing it. */
    prependMarkdown: z.string().optional(),
    /** New Markdown inserted after the existing document without replacing it. */
    appendMarkdown: z.string().optional(),
    /** Top-level block edits indexed against a `read_note` blocks response. */
    patches: z.array(NoteBlockPatchArgs).min(1).max(500).optional(),
    courseId: z.string().nullable().optional(),
    sectionId: z.string().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => value.markdown === undefined || value.doc === undefined, {
    message: 'supply markdown or doc, not both',
  })
  .refine(
    (value) =>
      (value.prependMarkdown === undefined &&
        value.appendMarkdown === undefined &&
        value.patches === undefined) ||
      (value.markdown === undefined && value.doc === undefined),
    { message: 'delta body edits cannot be combined with markdown or doc' },
  );

const ManageTagsArgs = z.object({
  noteId: z.string().min(1),
  baseUpdatedAt: z.string().datetime(),
  add: z.array(z.string()).default([]),
  remove: z.array(z.string()).default([]),
  rename: z
    .array(
      z.object({
        tagId: z.string().min(1),
        name: z.string().trim().min(1).max(100),
        namespace: z.enum(TAG_NAMESPACES).nullable(),
      }),
    )
    .default([]),
});

const CreateCourseArgs = z.object({
  name: z.string().min(1).max(200),
  professor: z.string().max(200).optional(),
  semester: z.string().max(100).optional(),
});

const ExportNotesArgs = z.object({
  noteIds: z.array(z.string().min(1)).min(1).max(500),
  format: z.enum(['markdown', 'html', 'pdf', 'docx']),
  fileName: z.string().min(1).max(200).optional(),
  /** Accepted for one release only so callers receive an actionable refusal. */
  destination: z.string().min(1).optional(),
  layout: z.enum(['combined', 'separate']).default('combined'),
  includeToc: z.boolean().default(true),
});

const OrganizeArgs = z
  .object({
    createSection: z
      .object({
        courseId: z.string().min(1),
        name: z.string().trim().min(1).max(200),
      })
      .optional(),
    moves: z
      .array(
        z.object({
          noteId: z.string().min(1),
          baseUpdatedAt: z.string().datetime(),
          courseId: z.string().nullable(),
          sectionId: z.string().nullable(),
        }),
      )
      .max(500)
      .default([]),
  })
  .refine((value) => value.createSection !== undefined || value.moves.length > 0, {
    message: 'createSection or at least one move is required',
  });

function invalid(issues: unknown): CommandResult<never> {
  return fail('invalid_input', 'invalid arguments', issues);
}

const ListTasksArgs = z.object({
  status: z.array(z.enum(TASK_STATUSES)).optional(),
  courseId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  /** Tasks linked to this note, by a manual link or an inline chip. */
  noteId: z.string().optional(),
  dueBefore: z.string().datetime({ offset: true }).optional(),
  /** `trashed` lists recoverable Trash; there is no way to empty it from here. */
  scope: z.enum(['live', 'trashed', 'all']).default('live'),
  sort: z.enum(['due', 'created', 'updated', 'priority', 'manual']).default('due'),
  limit: z.number().int().positive().max(500).default(200),
  offset: z.number().int().nonnegative().default(0),
});

const RecurrenceArgs = z.object({
  freq: z.enum(RECURRENCE_FREQS),
  interval: z.number().int().min(1).max(52).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).default([]),
});

const CreateTaskArgs = z.object({
  title: z.string().trim().min(1).max(500),
  details: z.string().max(10_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  courseId: z.string().nullable().optional(),
  /** Makes this a subtask. Depth is one level; a subtask of a subtask is refused. */
  parentId: z.string().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  remindAt: z.string().datetime({ offset: true }).nullable().optional(),
  recurrence: RecurrenceArgs.nullable().optional(),
  /** Notes to link the new task to. */
  noteIds: z.array(z.string()).max(100).optional(),
});

const UpdateTaskArgs = z
  .object({
    taskId: z.string().min(1),
    /** Optimistic-concurrency guard. Pass the `updatedAt` you read. */
    baseUpdatedAt: z.string().datetime({ offset: true }).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    details: z.string().max(10_000).optional(),
    prependDetails: z.string().max(10_000).optional(),
    appendDetails: z.string().max(10_000).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    courseId: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    remindAt: z.string().datetime({ offset: true }).nullable().optional(),
    recurrence: RecurrenceArgs.nullable().optional(),
    /**
     * Move to recoverable Trash, or restore from it. Folded in here rather than
     * given its own pair of tools so there is no shape on this surface that
     * resembles a delete — Trash is the hard boundary, and it cannot be emptied
     * from outside the app.
     */
    trashed: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.details === undefined ||
      (value.prependDetails === undefined && value.appendDetails === undefined),
    { message: 'details cannot be combined with prependDetails or appendDetails' },
  );

const CompleteTaskArgs = z.object({
  taskId: z.string().min(1),
  baseUpdatedAt: z.string().datetime({ offset: true }).optional(),
  /** `false` reopens a completed task. */
  done: z.boolean().default(true),
});

const LinkTaskNoteArgs = z.object({
  taskId: z.string().min(1),
  noteId: z.string().min(1),
  linked: z.boolean().default(true),
});

export const TOOL_HANDLERS: Record<AgentToolName, Handler> = {
  async list_courses(_args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const courses = await listCoursesCommand();
    if (!courses.ok) return courses;
    const withSections = [];
    for (const course of courses.value) {
      const stopped = cancelledIfRequested<unknown>(context);
      if (stopped) return stopped;
      const sections = await listSectionsCommand(course.id);
      if (!sections.ok) return sections;
      withSections.push({ ...course, sections: sections.value });
    }
    return ok(withSections);
  },

  async list_tags(_args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    return listTagsCommand();
  },

  async list_notes(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = ListNotesArgs.safeParse(args ?? {});
    if (!parsed.success) return invalid(parsed.error.issues);
    return queryNotesCommand({
      scope: parsed.data.scope,
      sort: 'updated',
      courseId: parsed.data.courseId,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  },

  async search_notes(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = SearchArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    // Same grammar the search box uses — one query language for humans and
    // agents alike.
    const [courses, tags] = await Promise.all([listCoursesCommand(), listTagsCommand()]);
    if (!courses.ok) return courses;
    if (!tags.ok) return tags;
    const resolved = resolveQuery(parseQuery(parsed.data.query), {
      courseIdByName: (name) =>
        courses.value.find((course) => course.name.toLowerCase() === name.toLowerCase())
          ?.id,
      tagIdByName: (namespace, name) =>
        tags.value.find(
          (tag) =>
            tag.namespace === namespace && tag.name.toLowerCase() === name.toLowerCase(),
        )?.id,
    });
    if (resolved.unresolvable) return ok([]);

    const { unresolvable: _unresolvable, ...query } = resolved;
    return queryNotesCommand({ ...query, limit: parsed.data.limit });
  },

  async read_note(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = ReadNoteArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    const [note, courses, tags] = await Promise.all([
      readNoteCommand(parsed.data.noteId),
      listCoursesCommand(),
      listTagsCommand(),
    ]);
    if (!note.ok) return note;
    if (!courses.ok) return courses;
    if (!tags.ok) return tags;

    return ok({
      id: note.value.id,
      title: note.value.title,
      course: courses.value.find((course) => course.id === note.value.courseId) ?? null,
      tags: tags.value.filter((tag) => note.value.tagIds.includes(tag.id)),
      courseId: note.value.courseId,
      sectionId: note.value.sectionId,
      tagIds: note.value.tagIds,
      updatedAt: note.value.updatedAt,
      doc:
        parsed.data.format === 'markdown' || parsed.data.format === 'blocks'
          ? undefined
          : note.value.doc,
      markdown:
        parsed.data.format === 'json' || parsed.data.format === 'blocks'
          ? undefined
          : docToMarkdown(note.value.doc),
      blocks:
        parsed.data.format === 'blocks'
          ? note.value.doc.content.map((node, index) => ({
              index,
              markdown: docToMarkdown({ type: 'doc', content: [node] }).trim(),
            }))
          : undefined,
    });
  },

  async create_note(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = CreateNoteArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    let source: Note | null = null;
    if (parsed.data.copyFrom) {
      const read = await readNoteCommand(parsed.data.copyFrom.noteId);
      if (!read.ok) return read;
      if (read.value.updatedAt !== parsed.data.copyFrom.baseUpdatedAt) {
        return fail('conflict', 'the note changed after it was read', {
          expectedUpdatedAt: parsed.data.copyFrom.baseUpdatedAt,
          actualUpdatedAt: read.value.updatedAt,
        });
      }
      source = read.value;
    }

    const tagIds: string[] =
      parsed.data.tags === undefined ? [...(source?.tagIds ?? [])] : [];
    for (const raw of parsed.data.tags ?? []) {
      const stopped = cancelledIfRequested<unknown>(context);
      if (stopped) return stopped;
      const [maybeNamespace, ...rest] = raw.split(':');
      const tag = await ensureTagCommand(
        rest.length > 0
          ? { namespace: maybeNamespace as never, name: rest.join(':') }
          : { name: raw },
        context,
      );
      if (!tag.ok) return tag;
      tagIds.push(tag.value.id);
    }

    const prefix = parsed.data.prependMarkdown
      ? markdownToDoc(parsed.data.prependMarkdown)
      : null;
    const suffix = parsed.data.appendMarkdown
      ? markdownToDoc(parsed.data.appendMarkdown)
      : null;
    const copiedDoc = source
      ? {
          type: 'doc' as const,
          content: [
            ...(prefix?.content ?? []),
            ...source.doc.content,
            ...(suffix?.content ?? []),
          ],
        }
      : undefined;

    return createNoteCommand(
      {
        title: parsed.data.title ?? source?.title,
        courseId: parsed.data.courseId ?? source?.courseId ?? null,
        sectionId: parsed.data.sectionId ?? source?.sectionId ?? null,
        doc:
          copiedDoc ??
          parsed.data.doc ??
          (parsed.data.markdown !== undefined
            ? markdownToDoc(parsed.data.markdown)
            : undefined),
        tagIds,
      },
      context,
    );
  },

  async update_note(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = UpdateNoteArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    const hasDeltaBodyEdit =
      parsed.data.prependMarkdown !== undefined ||
      parsed.data.appendMarkdown !== undefined ||
      parsed.data.patches !== undefined;
    const existing = hasDeltaBodyEdit ? await readNoteCommand(parsed.data.noteId) : null;
    if (existing && !existing.ok) return existing;
    const prefix = parsed.data.prependMarkdown
      ? markdownToDoc(parsed.data.prependMarkdown)
      : null;
    const suffix = parsed.data.appendMarkdown
      ? markdownToDoc(parsed.data.appendMarkdown)
      : null;
    const patched =
      existing?.ok && parsed.data.patches
        ? applyNoteBlockPatches(existing.value.doc.content, parsed.data.patches)
        : null;
    if (patched && !patched.ok) return patched;
    const deltaDoc = existing?.ok
      ? {
          type: 'doc' as const,
          content: [
            ...(prefix?.content ?? []),
            ...(patched?.ok ? patched.value : existing.value.doc.content),
            ...(suffix?.content ?? []),
          ],
        }
      : undefined;

    return updateNoteCommand(
      {
        noteId: parsed.data.noteId,
        baseUpdatedAt: parsed.data.baseUpdatedAt,
        title: parsed.data.title,
        courseId: parsed.data.courseId,
        sectionId: parsed.data.sectionId,
        archived: parsed.data.archived,
        doc:
          deltaDoc ??
          parsed.data.doc ??
          (parsed.data.markdown !== undefined
            ? markdownToDoc(parsed.data.markdown)
            : undefined),
      },
      context,
    );
  },

  async merge_notes(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = MergeNotesArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    const checked = await validateVersionedNotes(parsed.data.notes, context, 'live');
    if (!checked.ok) return checked;

    return mergeNotesCommand(
      {
        noteIds: parsed.data.notes.map((note) => note.noteId),
        baseUpdatedAtByNoteId: Object.fromEntries(
          parsed.data.notes.map((note) => [note.noteId, note.baseUpdatedAt]),
        ),
        title: parsed.data.title,
        sourceFate: parsed.data.sourceFate,
      },
      context,
    );
  },

  async trash_notes(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = VersionedNotesArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    const checked = await validateVersionedNotes(parsed.data.notes, context, 'live');
    if (!checked.ok) return checked;
    const versions = Object.fromEntries(
      parsed.data.notes.map((note) => [note.noteId, note.baseUpdatedAt]),
    );
    return trashNotesCommand(
      parsed.data.notes.map((note) => note.noteId),
      context,
      versions,
    );
  },

  async restore_notes(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = VersionedNotesArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    const checked = await validateVersionedNotes(parsed.data.notes, context, 'trashed');
    if (!checked.ok) return checked;
    const versions = Object.fromEntries(
      parsed.data.notes.map((note) => [note.noteId, note.baseUpdatedAt]),
    );
    return restoreNotesCommand(
      parsed.data.notes.map((note) => note.noteId),
      context,
      versions,
    );
  },

  async manage_tags(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = ManageTagsArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    const note = await readNoteCommand(parsed.data.noteId);
    if (!note.ok) return note;
    if (note.value.updatedAt !== parsed.data.baseUpdatedAt) {
      return fail('conflict', 'the note changed after it was read', {
        expectedUpdatedAt: parsed.data.baseUpdatedAt,
        actualUpdatedAt: note.value.updatedAt,
      });
    }

    const tagIds = new Set(note.value.tagIds);
    for (const raw of parsed.data.add) {
      const stopped = cancelledIfRequested<unknown>(context);
      if (stopped) return stopped;
      const [maybeNamespace, ...rest] = raw.split(':');
      const tag = await ensureTagCommand(
        rest.length > 0
          ? { namespace: maybeNamespace as never, name: rest.join(':') }
          : { name: raw },
        context,
      );
      if (!tag.ok) return tag;
      tagIds.add(tag.value.id);
    }
    for (const id of parsed.data.remove) tagIds.delete(id);

    const tags = await listTagsCommand();
    if (!tags.ok) return tags;
    for (const rename of parsed.data.rename) {
      const stopped = cancelledIfRequested<unknown>(context);
      if (stopped) return stopped;
      const tag = tags.value.find((entry) => entry.id === rename.tagId);
      if (!tag) return fail('not_found', `no tag ${rename.tagId}`);
      const renamed = await updateTagCommand(
        {
          ...tag,
          name: rename.name,
          namespace: rename.namespace,
        },
        context,
      );
      if (!renamed.ok) return renamed;
    }

    return updateNoteCommand(
      {
        noteId: note.value.id,
        baseUpdatedAt: parsed.data.baseUpdatedAt,
        tagIds: [...tagIds],
      },
      context,
    );
  },

  async create_course(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = CreateCourseArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    return createCourseCommand(parsed.data, context);
  },

  async export_notes(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = ExportNotesArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    if (parsed.data.destination !== undefined) {
      return fail(
        'invalid_input',
        'destination is no longer accepted; pass fileName to write inside Downloads/NotaBene exports',
      );
    }
    const fileName = parsed.data.fileName;
    if (!fileName) return fail('invalid_input', 'fileName is required');
    if (fileName.includes('/') || fileName.includes('\\')) {
      return fail('invalid_input', 'fileName must not contain a path separator');
    }
    const destination = joinPath(await storage.exportsDir(), fileName);
    return exportNotesCommand(parsed.data.noteIds, {
      format: parsed.data.format,
      destination,
      layout: parsed.data.layout,
      includeToc: parsed.data.includeToc,
      signal: context.signal,
    });
  },

  async list_tasks(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = ListTasksArgs.safeParse(args ?? {});
    if (!parsed.success) return invalid(parsed.error.issues);
    return listTasksCommand(parsed.data, context);
  },

  async create_task(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = CreateTaskArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    return createTaskCommand(parsed.data, context);
  },

  async update_task(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = UpdateTaskArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    const { trashed, prependDetails, appendDetails, ...fields } = parsed.data;
    if (trashed !== undefined) {
      // Trash and restore are whole-task moves that cascade to subtasks, so
      // they go through their own commands rather than being patched in.
      const moved = trashed
        ? await trashTasksCommand([fields.taskId], context)
        : await restoreTasksCommand([fields.taskId], context);
      if (!moved.ok) return moved;
      // Nothing else to write: `{ trashed }` on its own is the whole request.
      if (Object.keys(fields).length === 1) return readTask(fields.taskId);
    }
    if (prependDetails !== undefined || appendDetails !== undefined) {
      const current = await readTask(fields.taskId);
      if (!current.ok) return current;
      fields.details = joinTaskDetails(
        prependDetails,
        current.value.details,
        appendDetails,
      );
    }
    return updateTaskCommand(fields, context);
  },

  async complete_task(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = CompleteTaskArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    return completeTaskCommand(parsed.data, context);
  },

  async link_task_note(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = LinkTaskNoteArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    return linkTaskToNoteCommand(parsed.data, context);
  },

  async organize(args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const parsed = OrganizeArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    return organizeNotesCommand(parsed.data, context);
  },

  /** Lets an agent act on "the note I'm looking at". */
  async get_app_state(_args: unknown, context: CommandContext) {
    const cancelled = cancelledIfRequested<unknown>(context);
    if (cancelled) return cancelled;
    const editor = useEditorStore.getState();
    const ui = useUiStore.getState();
    // The Tasks view has its own subject. Without it, "break this down into
    // subtasks" arrives with no idea which task "this" is, and the agent has to
    // guess from `list_tasks`.
    const openTask =
      ui.view.kind === 'tasks' && ui.selectedTaskId
        ? (useLibraryStore
            .getState()
            .tasks.find((task) => task.id === ui.selectedTaskId) ?? null)
        : null;
    return ok({
      appVersion: __APP_VERSION__,
      openNoteId: editor.note?.id ?? null,
      openNoteTitle: editor.note?.title ?? null,
      saveState: editor.saveState,
      view: ui.view,
      selection: ui.multiSelection,
      openTaskId: openTask?.id ?? null,
      openTaskTitle: openTask?.title ?? null,
    });
  },
};

/** Read a task back so a trash or restore answers with the row it moved. */
async function readTask(taskId: string): Promise<CommandResult<Task>> {
  const tasks = await listTasksCommand({ scope: 'all', limit: 500 });
  if (!tasks.ok) return tasks;
  const task = tasks.value.find((entry) => entry.id === taskId);
  return task ? ok(task) : fail('not_found', `no task ${taskId}`);
}

function applyNoteBlockPatches(
  original: Note['doc']['content'],
  patches: z.infer<typeof NoteBlockPatchArgs>[],
): CommandResult<Note['doc']['content']> {
  const grouped = new Map<number, typeof patches>();
  for (const patch of patches) {
    if (patch.index > original.length) {
      return fail(
        'invalid_input',
        `block patch index ${patch.index} is outside the note`,
      );
    }
    const atIndex = grouped.get(patch.index) ?? [];
    if (patch.action !== 'insert' && atIndex.some((entry) => entry.action !== 'insert')) {
      return fail(
        'invalid_input',
        `block ${patch.index} has more than one replacement or removal`,
      );
    }
    atIndex.push(patch);
    grouped.set(patch.index, atIndex);
  }

  const content: Note['doc']['content'] = [];
  for (let index = 0; index <= original.length; index += 1) {
    const atIndex = grouped.get(index) ?? [];
    for (const patch of atIndex.filter((entry) => entry.action === 'insert')) {
      content.push(...markdownToDoc(patch.markdown ?? '').content);
    }
    if (index === original.length) break;
    const mutation = atIndex.find((entry) => entry.action !== 'insert');
    if (!mutation) content.push(original[index]!);
    else if (mutation.action === 'replace') {
      content.push(...markdownToDoc(mutation.markdown ?? '').content);
    }
  }
  return ok(content);
}

function joinTaskDetails(
  before: string | undefined,
  current: string,
  after: string | undefined,
): string {
  return [before, current, after]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n\n');
}

async function validateVersionedNotes(
  requested: { noteId: string; baseUpdatedAt: string }[],
  context: CommandContext,
  expectedState: 'live' | 'trashed',
): Promise<CommandResult<Note[]>> {
  if (new Set(requested.map((note) => note.noteId)).size !== requested.length) {
    return fail('invalid_input', 'each note may appear only once');
  }
  const notes: Note[] = [];
  for (const request of requested) {
    const cancelled = cancelledIfRequested<Note[]>(context);
    if (cancelled) return cancelled;
    const result = await readNoteCommand(request.noteId);
    if (!result.ok) return result;
    if (result.value.updatedAt !== request.baseUpdatedAt) {
      return fail('conflict', 'the note changed after it was read', {
        noteId: result.value.id,
        expectedUpdatedAt: request.baseUpdatedAt,
        actualUpdatedAt: result.value.updatedAt,
      });
    }
    const isTrashed = result.value.trashedAt !== null;
    if (expectedState === 'live' ? isTrashed : !isTrashed) {
      return fail(
        'invalid_input',
        expectedState === 'live'
          ? 'a note is already in Trash'
          : 'a note is not in Trash',
        { noteId: result.value.id },
      );
    }
    notes.push(result.value);
  }
  return ok(notes);
}

/** One invocation door for the MCP bridge and the in-app loop. */
export function executeToolHandler(
  method: AgentToolName,
  args: unknown,
  context: CommandContext,
): Promise<CommandResult<unknown>> {
  return TOOL_HANDLERS[method](args, context);
}

export type ToolMethod = AgentToolName;
