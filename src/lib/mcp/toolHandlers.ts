/**
 * MCP tool implementations.
 *
 * Each handler validates its own arguments and then delegates to a command —
 * it never reaches for an adapter directly. Note what is *not* here: no delete.
 * v1 exposes archiving instead, so no agent can destroy a student's notes
 * (PRD §5.7).
 */
import { z } from 'zod';
import { library } from '@/lib/adapters';
import {
  createNoteCommand,
  createCourseCommand,
  ensureTagCommand,
  fail,
  ok,
  updateNoteCommand,
  type CommandContext,
  type CommandResult,
} from '@/lib/commands';
import { parseQuery, resolveQuery } from '@/lib/search/query';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';

type Handler = (args: unknown, context: CommandContext) => Promise<CommandResult<unknown>>;

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

const CreateNoteArgs = z.object({
  title: z.string().max(500).optional(),
  courseId: z.string().optional(),
  sectionId: z.string().optional(),
  /** Markdown is the friendlier input for an agent; the server converts. */
  markdown: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

const UpdateNoteArgs = z.object({
  noteId: z.string().min(1),
  title: z.string().max(500).optional(),
  markdown: z.string().optional(),
  courseId: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});

const ManageTagsArgs = z.object({
  noteId: z.string().min(1),
  add: z.array(z.string()).default([]),
  remove: z.array(z.string()).default([]),
});

const CreateCourseArgs = z.object({
  name: z.string().min(1).max(200),
  professor: z.string().max(200).optional(),
  semester: z.string().max(100).optional(),
});

function invalid(issues: unknown): CommandResult<never> {
  return fail('invalid_input', 'invalid arguments', issues);
}

/**
 * Markdown ⇄ document conversion.
 *
 * Phase A treats markdown as plain paragraphs so the write path is exercised
 * end to end. Phase B swaps in the real TipTap markdown parser from
 * `src/editor/markdown/` — the handler signature does not change.
 */
function markdownToDoc(markdown: string) {
  return {
    type: 'doc' as const,
    content: markdown.split('\n').map((line) =>
      line
        ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
        : { type: 'paragraph' },
    ),
  };
}

export const TOOL_HANDLERS = {
  async list_courses() {
    return ok(await library.listCourses());
  },

  async list_notes(args: unknown) {
    const parsed = ListNotesArgs.safeParse(args ?? {});
    if (!parsed.success) return invalid(parsed.error.issues);
    return ok(
      await library.queryNotes({
        scope: 'live',
        sort: 'updated',
        courseId: parsed.data.courseId,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      }),
    );
  },

  async search_notes(args: unknown) {
    const parsed = SearchArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    // Same grammar the search box uses — one query language for humans and
    // agents alike.
    const [courses, tags] = await Promise.all([library.listCourses(), library.listTags()]);
    const resolved = resolveQuery(parseQuery(parsed.data.query), {
      courseIdByName: (name) =>
        courses.find((course) => course.name.toLowerCase() === name.toLowerCase())?.id,
      tagIdByName: (namespace, name) =>
        tags.find(
          (tag) =>
            tag.namespace === namespace && tag.name.toLowerCase() === name.toLowerCase(),
        )?.id,
    });
    if (resolved.unresolvable) return ok([]);

    const { unresolvable: _unresolvable, ...query } = resolved;
    return ok(await library.queryNotes({ ...query, limit: parsed.data.limit }));
  },

  async read_note(args: unknown) {
    const parsed = ReadNoteArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    const note = await library.getNote(parsed.data.noteId);
    if (!note) return fail('not_found', `no note ${parsed.data.noteId}`);

    return ok({
      id: note.id,
      title: note.title,
      courseId: note.courseId,
      tagIds: note.tagIds,
      updatedAt: note.updatedAt,
      doc: parsed.data.format === 'markdown' ? undefined : note.doc,
      markdown: parsed.data.format === 'json' ? undefined : note.plainText,
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
      if (tag.ok) tagIds.push(tag.value.id);
    }

    return createNoteCommand(
      {
        title: parsed.data.title,
        courseId: parsed.data.courseId ?? null,
        sectionId: parsed.data.sectionId ?? null,
        doc: parsed.data.markdown ? markdownToDoc(parsed.data.markdown) : undefined,
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
        title: parsed.data.title,
        courseId: parsed.data.courseId,
        archived: parsed.data.archived,
        doc: parsed.data.markdown ? markdownToDoc(parsed.data.markdown) : undefined,
      },
      context,
    );
  },

  async manage_tags(args: unknown, context: CommandContext) {
    const parsed = ManageTagsArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);

    const note = await library.getNote(parsed.data.noteId);
    if (!note) return fail('not_found', `no note ${parsed.data.noteId}`);

    const tagIds = new Set(note.tagIds);
    for (const raw of parsed.data.add) {
      const [maybeNamespace, ...rest] = raw.split(':');
      const tag = await ensureTagCommand(
        rest.length > 0
          ? { namespace: maybeNamespace as never, name: rest.join(':') }
          : { name: raw },
        context,
      );
      if (tag.ok) tagIds.add(tag.value.id);
    }
    for (const id of parsed.data.remove) tagIds.delete(id);

    return updateNoteCommand({ noteId: note.id, tagIds: [...tagIds] }, context);
  },

  async create_course(args: unknown, context: CommandContext) {
    const parsed = CreateCourseArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    return createCourseCommand(parsed.data, context);
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
