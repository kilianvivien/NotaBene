/**
 * MCP tool implementations.
 *
 * Each handler validates its own arguments and then delegates to a command —
 * it never reaches for an adapter directly. Note what is *not* here: no delete.
 * v1 exposes archiving instead, so no agent can destroy a student's notes
 * (PRD §5.7).
 */
import { z } from 'zod';
import {
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
import { NoteDocSchema, TAG_NAMESPACES } from '@/lib/schema';
import { parseQuery, resolveQuery } from '@/lib/search/query';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { docToMarkdown, markdownToDoc } from '@/editor/markdown';

type Handler = (
  args: unknown,
  context: CommandContext,
) => Promise<CommandResult<unknown>>;

const ListNotesArgs = z.object({
  courseId: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
});

const SearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(200).default(50),
});

const ReadNoteArgs = z.object({
  noteId: z.string().min(1),
  /** `json` gives the document tree; `markdown` gives rendered text. */
  format: z.enum(['json', 'markdown', 'both']).default('both'),
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
    tags: z.array(z.string()).default([]),
  })
  .refine((value) => value.markdown === undefined || value.doc === undefined, {
    message: 'supply markdown or doc, not both',
  });

const UpdateNoteArgs = z
  .object({
    noteId: z.string().min(1),
    /** Required optimistic-concurrency token returned by read/list/search. */
    baseUpdatedAt: z.string().datetime(),
    title: z.string().max(500).optional(),
    markdown: z.string().optional(),
    doc: NoteDocSchema.optional(),
    courseId: z.string().nullable().optional(),
    sectionId: z.string().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => value.markdown === undefined || value.doc === undefined, {
    message: 'supply markdown or doc, not both',
  });

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
  destination: z.string().min(1),
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

export const TOOL_HANDLERS = {
  async list_courses() {
    const courses = await listCoursesCommand();
    if (!courses.ok) return courses;
    const withSections = [];
    for (const course of courses.value) {
      const sections = await listSectionsCommand(course.id);
      if (!sections.ok) return sections;
      withSections.push({ ...course, sections: sections.value });
    }
    return ok(withSections);
  },

  async list_notes(args: unknown) {
    const parsed = ListNotesArgs.safeParse(args ?? {});
    if (!parsed.success) return invalid(parsed.error.issues);
    return queryNotesCommand({
      scope: 'live',
      sort: 'updated',
      courseId: parsed.data.courseId,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  },

  async search_notes(args: unknown) {
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

  async read_note(args: unknown) {
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
      doc: parsed.data.format === 'markdown' ? undefined : note.value.doc,
      markdown: parsed.data.format === 'json' ? undefined : docToMarkdown(note.value.doc),
    });
  },

  async create_note(args: unknown, context: CommandContext) {
    const parsed = CreateNoteArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    const tagIds: string[] = [];
    for (const raw of parsed.data.tags) {
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

    return createNoteCommand(
      {
        title: parsed.data.title,
        courseId: parsed.data.courseId ?? null,
        sectionId: parsed.data.sectionId ?? null,
        doc:
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
    const parsed = UpdateNoteArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    return updateNoteCommand(
      {
        noteId: parsed.data.noteId,
        baseUpdatedAt: parsed.data.baseUpdatedAt,
        title: parsed.data.title,
        courseId: parsed.data.courseId,
        sectionId: parsed.data.sectionId,
        archived: parsed.data.archived,
        doc:
          parsed.data.doc ??
          (parsed.data.markdown !== undefined
            ? markdownToDoc(parsed.data.markdown)
            : undefined),
      },
      context,
    );
  },

  async manage_tags(args: unknown, context: CommandContext) {
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
    const parsed = CreateCourseArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    return createCourseCommand(parsed.data, context);
  },

  async export_notes(args: unknown) {
    const parsed = ExportNotesArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    return exportNotesCommand(parsed.data.noteIds, {
      format: parsed.data.format,
      destination: parsed.data.destination,
      layout: parsed.data.layout,
      includeToc: parsed.data.includeToc,
    });
  },

  async organize(args: unknown, context: CommandContext) {
    const parsed = OrganizeArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    return organizeNotesCommand(parsed.data, context);
  },

  /** Lets an agent act on "the note I'm looking at". */
  async get_app_state() {
    const editor = useEditorStore.getState();
    const ui = useUiStore.getState();
    return ok({
      appVersion: __APP_VERSION__,
      openNoteId: editor.note?.id ?? null,
      openNoteTitle: editor.note?.title ?? null,
      saveState: editor.saveState,
      view: ui.view,
      selection: ui.multiSelection,
    });
  },
} satisfies Record<string, Handler>;

export type ToolMethod = keyof typeof TOOL_HANDLERS;
