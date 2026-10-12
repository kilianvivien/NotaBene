/**
 * The graph view's reads, and the one write it leads to.
 *
 * The reads are a façade like `readCommands`; they also parse what comes back,
 * because the graph is the one read whose shape no other test pins from both
 * ends. Turning an unlinked mention into a link is an ordinary edit: it goes
 * through `updateNoteCommand`, so it is versioned, concurrency-checked and
 * undoable from the version list like anything typed.
 */
import { library } from '@/lib/adapters';
import {
  LINK_EXCERPT_CHARS,
  MAX_LINK_SUGGESTION_NOTES,
  requestLinkSuggestions,
  type AiRunOptions,
  type LinkSuggestion,
} from '@/lib/ai';
import { findMention } from '@/lib/graph/mentions';
import {
  LibraryGraphSchema,
  UnlinkedMentionSchema,
  type DocNode,
  type LibraryGraph,
  type Note,
  type NoteDoc,
  type UnlinkedMention,
} from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { aiFailure, language, providerFor } from './aiCommands';
import { applyNoteUpdate, updateNoteCommand } from './noteCommands';
import { fail, ok, USER, type CommandContext, type CommandResult } from './types';

export async function readGraphCommand(options: {
  mentions: boolean;
}): Promise<CommandResult<LibraryGraph>> {
  try {
    return ok(LibraryGraphSchema.parse(await library.getGraph(options)));
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function listUnlinkedMentionsCommand(
  noteId: string,
): Promise<CommandResult<UnlinkedMention[]>> {
  try {
    return ok(
      UnlinkedMentionSchema.array().parse(await library.listUnlinkedMentions(noteId)),
    );
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

/** Text a link must not be cut out of: code is literal, and a web link would
 * lose its address. */
const UNLINKABLE_MARKS = new Set(['code', 'link']);
const UNLINKABLE_BLOCKS = new Set(['codeBlock']);

/**
 * Replace the first mention of `title` in a text node with a wiki link.
 *
 * Only a mention that sits inside one text node can be replaced. One that
 * straddles a formatting change — half of it bold — is in `plainText` but is
 * not one node here, and stitching marks back together around a link is a
 * guess about what the student meant. Those are reported, not rewritten.
 */
export function linkFirstMention(
  doc: NoteDoc,
  target: Pick<Note, 'id' | 'title'>,
): NoteDoc | null {
  let linked = false;

  function rewrite(nodes: DocNode[]): DocNode[] {
    const out: DocNode[] = [];
    for (const node of nodes) {
      if (linked || UNLINKABLE_BLOCKS.has(node.type)) {
        out.push(node);
        continue;
      }
      if (node.type === 'text' && typeof node.text === 'string') {
        const blocked = node.marks?.some((mark) => UNLINKABLE_MARKS.has(mark.type));
        const match = blocked ? null : findMention(node.text, target.title);
        if (!match) {
          out.push(node);
          continue;
        }
        linked = true;
        const written = node.text.slice(match.start, match.end);
        const before = node.text.slice(0, match.start);
        const after = node.text.slice(match.end);
        if (before) out.push({ ...node, text: before });
        out.push({
          type: 'wikiLink',
          attrs: {
            noteId: target.id,
            title: target.title.trim(),
            // Keep the student's own casing on the page; the title is still
            // what the link resolves by.
            label: written === target.title.trim() ? null : written,
          },
        });
        if (after) out.push({ ...node, text: after });
        continue;
      }
      out.push(node.content ? { ...node, content: rewrite(node.content) } : node);
    }
    return out;
  }

  const content = rewrite(doc.content);
  return linked ? { ...doc, content } : null;
}

/**
 * Turn `sourceId`'s unlinked mention of `targetId` into a link.
 *
 * Fails with `not_supported` when the mention cannot be replaced in place
 * (see `linkFirstMention`) — the surface says so and offers to open the note.
 */
export async function linkMentionCommand(
  input: { sourceId: string; targetId: string },
  context: CommandContext = USER,
): Promise<CommandResult<Note>> {
  if (input.sourceId === input.targetId) {
    return fail('invalid_input', 'a note cannot link to itself');
  }
  // The note being rewritten may be the one on screen with a keystroke not
  // yet saved; read it only after that has landed.
  const editor = useEditorStore.getState();
  const open = editor.note?.id === input.sourceId;
  if (open) await editor.flush();

  let source: Note | null;
  let target: Note | null;
  try {
    [source, target] = await Promise.all([
      library.getNote(input.sourceId),
      library.getNote(input.targetId),
    ]);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
  if (!source || source.trashedAt) return fail('not_found', `no note ${input.sourceId}`);
  if (!target || target.trashedAt) return fail('not_found', `no note ${input.targetId}`);

  const doc = linkFirstMention(source.doc, target);
  if (!doc) {
    return fail('not_supported', 'the mention cannot be linked in place', {
      reason: 'mention_not_in_one_run',
    });
  }
  const result = await updateNoteCommand(
    { noteId: source.id, doc, baseUpdatedAt: source.updatedAt },
    context,
  );
  // `updateNoteCommand` reloads an open editor for every writer but the user,
  // on the grounds that the user's edit came *from* the editor. This one did
  // not.
  if (result.ok && open) await useEditorStore.getState().openNote(source.id);
  return result;
}

/** One unlinked mention, with what a caller needs to link it. */
export interface MentionRef {
  sourceId: string;
  sourceTitle: string;
  /** The concurrency token `linkMentionsCommand` checks. */
  sourceUpdatedAt: string;
  targetId: string;
  targetTitle: string;
}

export interface FindMentionsInput {
  /** Keep mentions with either end in this list. */
  noteIds?: string[];
  /** Keep mentions whose *source* — the note that would be edited — is in
   * this course. */
  courseId?: string;
  limit?: number;
}

/**
 * The library's unlinked mentions as a list, for the agent.
 *
 * The graph view draws the same edges; this is that read with titles and
 * concurrency tokens attached, so a caller can go straight from finding
 * mentions to linking them without a `read_note` per note.
 */
export async function findMentionsCommand(
  input: FindMentionsInput = {},
): Promise<CommandResult<{ mentions: MentionRef[]; total: number }>> {
  const graph = await readGraphCommand({ mentions: true });
  if (!graph.ok) return graph;
  const nodes = new Map(graph.value.nodes.map((node) => [node.id, node]));
  const wanted = input.noteIds ? new Set(input.noteIds) : null;
  const found: MentionRef[] = [];
  for (const edge of graph.value.mentions) {
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (!source || !target) continue;
    if (wanted && !wanted.has(source.id) && !wanted.has(target.id)) continue;
    if (input.courseId !== undefined && source.courseId !== input.courseId) continue;
    found.push({
      sourceId: source.id,
      sourceTitle: source.title,
      sourceUpdatedAt: source.updatedAt,
      targetId: target.id,
      targetTitle: target.title,
    });
  }
  return ok({ mentions: found.slice(0, input.limit ?? 100), total: found.length });
}

export interface LinkMentionsResult {
  /** Mentions that became links. */
  linked: number;
  /** Notes that were edited — one version each, however many links it gained. */
  notes: number;
  /** Mentions left alone, and why. Never a failure of the call. */
  skipped: {
    sourceId: string;
    targetId: string;
    reason: 'not_found' | 'not_in_one_run';
  }[];
}

/**
 * Turn many unlinked mentions into links.
 *
 * The bulk form of `linkMentionCommand`, for the agent. Two things it does
 * that a loop over the single command would not:
 *
 * - A note that mentions three others is written **once**, with three links,
 *   so it gains one version instead of three and its `baseUpdatedAt` — which
 *   the caller read before any of them — is still the right token.
 * - Every `baseUpdatedAt` is checked before anything is written, so a stale
 *   read refuses the whole call instead of linking half a library.
 *
 * A mention that cannot be replaced in place (see `linkFirstMention`) is
 * reported in `skipped` and the rest go ahead.
 */
export async function linkMentionsCommand(
  links: { sourceId: string; targetId: string; baseUpdatedAt?: string }[],
  context: CommandContext = USER,
): Promise<CommandResult<LinkMentionsResult>> {
  const editor = useEditorStore.getState();
  const openId = editor.note?.id ?? null;
  if (openId && links.some((link) => link.sourceId === openId)) await editor.flush();

  const bySource = new Map<string, typeof links>();
  for (const link of links) {
    if (link.sourceId === link.targetId) {
      return fail('invalid_input', 'a note cannot link to itself');
    }
    bySource.set(link.sourceId, [...(bySource.get(link.sourceId) ?? []), link]);
  }

  const result: LinkMentionsResult = { linked: 0, notes: 0, skipped: [] };
  const sources = new Map<string, Note>();
  try {
    for (const [sourceId, group] of bySource) {
      const source = await library.getNote(sourceId);
      if (!source || source.trashedAt) {
        for (const link of group)
          result.skipped.push({ ...pair(link), reason: 'not_found' });
        continue;
      }
      const stale = group.find(
        (link) =>
          link.baseUpdatedAt !== undefined && link.baseUpdatedAt !== source.updatedAt,
      );
      if (stale) {
        return fail('conflict', 'the note changed after it was read', {
          noteId: source.id,
          expectedUpdatedAt: stale.baseUpdatedAt,
          actualUpdatedAt: source.updatedAt,
        });
      }
      sources.set(sourceId, source);
    }

    for (const [sourceId, source] of sources) {
      if (context.signal?.aborted) break;
      let doc = source.doc;
      let gained = 0;
      for (const link of bySource.get(sourceId)!) {
        const target = await library.getNote(link.targetId);
        if (!target || target.trashedAt) {
          result.skipped.push({ ...pair(link), reason: 'not_found' });
          continue;
        }
        const next = linkFirstMention(doc, target);
        if (!next) {
          result.skipped.push({ ...pair(link), reason: 'not_in_one_run' });
          continue;
        }
        doc = next;
        gained += 1;
      }
      if (!gained) continue;
      const written = await applyNoteUpdate(
        { noteId: source.id, doc, baseUpdatedAt: source.updatedAt },
        context,
      );
      if (!written.ok) {
        await useLibraryStore.getState().refreshCurrentView();
        return fail(written.code, written.message, {
          ...result,
          failedNoteId: source.id,
        });
      }
      result.linked += gained;
      result.notes += 1;
    }
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }

  // One refresh for the whole batch, as every bulk write does.
  await useLibraryStore.getState().refreshCurrentView();
  if (openId && sources.has(openId) && context.source === 'user') {
    await useEditorStore.getState().openNote(openId);
  }
  return ok(result);
}

function pair(link: { sourceId: string; targetId: string }) {
  return { sourceId: link.sourceId, targetId: link.targetId };
}

export interface LinkSuggestionsResult {
  suggestions: LinkSuggestion[];
  /** How many notes the model was shown, and how many there are. When the
   * second is larger, the most recently edited were the ones shown. */
  considered: number;
  total: number;
}

/**
 * Ask the model which notes belong together. Writes nothing.
 *
 * For a library with few or no links, where there is nothing for the graph
 * to draw and no mention to offer. The model sees titles, courses and how
 * each note begins — not whole notes: sixty of those would not fit a small
 * context, and the opening of a class note is where it says what it is about.
 */
export async function suggestLinksCommand(
  options: AiRunOptions = {},
): Promise<CommandResult<LinkSuggestionsResult>> {
  await useEditorStore.getState().flush();
  const lookup = await providerFor('default');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  const graph = await readGraphCommand({ mentions: false });
  if (!graph.ok) return graph;
  const total = graph.value.nodes.length;
  if (total < 2) return ok({ suggestions: [], considered: total, total });

  const chosen = [...graph.value.nodes]
    .filter((node) => node.title.trim() && node.size > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_LINK_SUGGESTION_NOTES);
  const courses = new Map(
    useLibraryStore.getState().courses.map((course) => [course.id, course.name]),
  );

  try {
    const notes = [];
    for (const node of chosen) {
      const note = await library.getNote(node.id);
      if (!note) continue;
      notes.push({
        id: note.id,
        title: note.title.trim(),
        course: note.courseId ? (courses.get(note.courseId) ?? null) : null,
        excerpt: note.plainText.replace(/\s+/g, ' ').trim().slice(0, LINK_EXCERPT_CHARS),
      });
    }
    const suggestions = await requestLinkSuggestions(
      {
        provider: lookup.provider,
        notes,
        linked: new Set(
          graph.value.edges.map((edge) => `${edge.sourceId}>${edge.targetId}`),
        ),
        language: language(),
      },
      options,
    );
    return ok({ suggestions, considered: notes.length, total });
  } catch (error) {
    return aiFailure(error, options.signal);
  }
}

/**
 * Add a link to `target` at the foot of a note, under a "See also" line.
 *
 * A suggested link has no words in the note to become a link — that is what
 * distinguishes it from a mention — so it is appended rather than placed. A
 * note that already ends with a see-also line gains the link on that line,
 * instead of a new paragraph per accepted suggestion.
 */
export function appendSeeAlso(
  doc: NoteDoc,
  target: Pick<Note, 'id' | 'title'>,
  label: string,
): NoteDoc {
  const link: DocNode = {
    type: 'wikiLink',
    attrs: { noteId: target.id, title: target.title.trim(), label: null },
  };
  const lead = `${label} `;
  const last = doc.content[doc.content.length - 1];
  if (
    last?.type === 'paragraph' &&
    last.content?.[0]?.type === 'text' &&
    last.content[0].text === lead
  ) {
    return {
      ...doc,
      content: [
        ...doc.content.slice(0, -1),
        { ...last, content: [...last.content, { type: 'text', text: ', ' }, link] },
      ],
    };
  }
  return {
    ...doc,
    content: [
      ...doc.content,
      { type: 'paragraph', content: [{ type: 'text', text: lead }, link] },
    ],
  };
}

/**
 * Accept one suggested link. An AI write: it carries `source: 'ai'`, so the
 * version before it is kept and labelled as such.
 */
export async function acceptSuggestedLinkCommand(input: {
  sourceId: string;
  targetId: string;
  /** The translated "See also:" the line starts with. */
  label: string;
}): Promise<CommandResult<Note>> {
  if (input.sourceId === input.targetId) {
    return fail('invalid_input', 'a note cannot link to itself');
  }
  const editor = useEditorStore.getState();
  if (editor.note?.id === input.sourceId) await editor.flush();
  let source: Note | null;
  let target: Note | null;
  try {
    [source, target] = await Promise.all([
      library.getNote(input.sourceId),
      library.getNote(input.targetId),
    ]);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
  if (!source || source.trashedAt) return fail('not_found', `no note ${input.sourceId}`);
  if (!target || target.trashedAt) return fail('not_found', `no note ${input.targetId}`);
  return updateNoteCommand(
    {
      noteId: source.id,
      doc: appendSeeAlso(source.doc, target, input.label),
      baseUpdatedAt: source.updatedAt,
    },
    { source: 'ai' },
  );
}
