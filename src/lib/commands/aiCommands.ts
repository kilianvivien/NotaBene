/**
 * AI mutations.
 *
 * Every one of these ends in a call to `createNoteCommand` or
 * `updateNoteCommand` with `source: 'ai'`, which is what makes the plan's three
 * guards real rather than aspirational:
 *
 *   1. the model's output was parsed through a Zod schema in `src/lib/ai/`;
 *   2. the user accepted specific blocks in the diff panel;
 *   3. `updateNoteCommand` snapshots the pre-edit note with `cause: 'ai'`
 *      before writing, so the version being replaced is in history.
 *
 * Producing the proposal is *not* a command — nothing is mutated by asking a
 * model a question, and putting the network call behind the same door as a
 * write would only blur where the guards are.
 */
import { z } from 'zod';
import { markdownToDoc } from '@/editor/markdown';
import { library } from '@/lib/adapters';
import {
  applyProposal,
  checkSourceLimits,
  estimateTokens,
  loadProvider,
  requestAnswer,
  requestRewrite,
  requestSynthesis,
  resolveFeature,
  type AiFeature,
  type AiRunOptions,
  type AiUnavailableReason,
  type AskMode,
  type AskScope,
  type AskTurn,
  type ResolvedProvider,
  type RewriteMode,
  type RewriteResult,
  type SynthesisStyle,
} from '@/lib/ai';
import { RewriteProposalSchema, type Note } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useAiStore } from '@/lib/state/aiStore';
import { createNoteCommand, updateNoteCommand } from './noteCommands';
import { ensureTagCommand } from './organizationCommands';
import { gatherAskSourcesCommand } from './retrievalCommands';
import { fail, ok, type CommandResult } from './types';

/** Every AI command runs as the AI, never as the user: the snapshot cause and
 * the version history entry both depend on it. */
const AI = { source: 'ai' } as const;

export type ProviderLookup =
  | { ok: true; provider: ResolvedProvider }
  | { ok: false; reason: AiUnavailableReason | string };

/** `not_supported` carries the reason verbatim so the UI can turn it into the
 * right sentence — "connect a provider" and "that provider has no address" send
 * the user to different places.
 *
 * Exported because the study features in `studyCommands.ts` resolve providers
 * the same way; "which provider answers what" gets one implementation. */
export async function providerFor(feature: AiFeature): Promise<ProviderLookup> {
  const settings = useSettingsStore.getState().settings;
  const keyed = useAiStore.getState().configuredProviderIds;
  // Detection is refreshed by the UI, not here: a run must not wait on a probe
  // to a runtime that may not be listening. Whatever the last look found is
  // what the pill promised, and the two have to agree.
  const detected = useAiStore.getState().localModels;
  const availability = resolveFeature(feature, settings, keyed, detected);
  if (!availability.available) return { ok: false, reason: availability.reason };
  try {
    return { ok: true, provider: await loadProvider(availability) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function language(): string {
  return useSettingsStore.getState().settings.locale;
}

/**
 * Refuse a selection that is too big for a multi-note AI feature, or `null`.
 *
 * Shared by synthesis, flashcards and podcast: all three read the same
 * `multiSelection`, and before bulk selection existed none of them could be
 * handed more than one note. The reason travels in `details` rather than in
 * the message, because the dialog has to say it in the student's language and
 * a string assembled here would arrive in whatever this file was written in.
 */
export function sourceLimitFailure<T>(notes: Note[]): CommandResult<T> | null {
  const over = checkSourceLimits(notes, estimateTokens);
  if (!over) return null;
  return fail(
    'invalid_input',
    over.limit === 'too_many_notes'
      ? `${over.notes} notes selected, over the limit`
      : `about ${over.tokens} tokens selected, over the budget`,
    over,
  );
}

// -- Rewrite -----------------------------------------------------------------

export interface ProposeRewriteInput {
  noteId: string;
  mode: RewriteMode;
  instruction?: string;
}

/**
 * Ask for a rewrite. Returns a proposal; writes nothing.
 *
 * Flushes the editor first. Autosave debounces by 800 ms, so a user who
 * finishes a sentence and immediately presses Rewrite would otherwise have the
 * model correct the version from before that sentence — and then the diff would
 * offer to delete it.
 */
export async function proposeRewriteCommand(
  input: ProposeRewriteInput,
  options: AiRunOptions = {},
): Promise<CommandResult<RewriteResult>> {
  await useEditorStore.getState().flush();
  const note = await library.getNote(input.noteId);
  if (!note) return fail('not_found', `no note ${input.noteId}`);

  const lookup = await providerFor('rewrite');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    const result = await requestRewrite(
      {
        provider: lookup.provider,
        doc: note.doc,
        mode: input.mode,
        instruction: input.instruction,
        language: language(),
      },
      options,
    );
    return ok(result);
  } catch (error) {
    return fail('invalid_input', error instanceof Error ? error.message : String(error));
  }
}

const ApplyRewriteInput = z.object({
  noteId: z.string().min(1),
  proposal: RewriteProposalSchema,
  /** Positions in `proposal.blocks`, not block indexes — two edits can target
   * the same block, and the user accepts them one at a time. */
  accepted: z.array(z.number().int().nonnegative()),
});
export type ApplyRewriteInput = z.infer<typeof ApplyRewriteInput>;

export async function applyRewriteCommand(
  input: ApplyRewriteInput,
): Promise<CommandResult<Note>> {
  const parsed = ApplyRewriteInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid rewrite input', parsed.error.issues);
  }
  if (!parsed.data.accepted.length) {
    return fail('invalid_input', 'nothing accepted');
  }

  await useEditorStore.getState().flush();
  const note = await library.getNote(parsed.data.noteId);
  if (!note) return fail('not_found', `no note ${parsed.data.noteId}`);

  const doc = applyProposal(
    note.doc,
    parsed.data.proposal,
    new Set(parsed.data.accepted),
  );
  const result = await updateNoteCommand({ noteId: note.id, doc }, AI);
  if (result.ok) await useEditorStore.getState().openNote(note.id);
  return result;
}

// -- Synthesis ---------------------------------------------------------------

export interface SynthesizeInput {
  noteIds: string[];
  style: SynthesisStyle;
  /** Free-text brief, for the `custom` style. Empty for the preset shapes. */
  instructions?: string;
}

/**
 * Summarise one or more notes into a new one.
 *
 * The new note lands beside its sources — in the same course when they agree on
 * one, in the inbox when they do not — tagged `type:summary` and linking back.
 * Filing it somewhere the student was not looking is how a generated note gets
 * lost the moment it is made.
 */
export async function synthesizeNotesCommand(
  input: SynthesizeInput,
  options: AiRunOptions = {},
): Promise<CommandResult<Note>> {
  await useEditorStore.getState().flush();

  const notes: Note[] = [];
  for (const noteId of input.noteIds) {
    const note = await library.getNote(noteId);
    if (note) notes.push(note);
  }
  if (!notes.length) return fail('not_found', 'none of those notes exist');
  const overLimit = sourceLimitFailure<Note>(notes);
  if (overLimit) return overLimit;

  const lookup = await providerFor('synthesis');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  let result;
  try {
    result = await requestSynthesis(
      {
        provider: lookup.provider,
        sources: notes,
        style: input.style,
        instructions: input.instructions,
        language: language(),
      },
      options,
    );
  } catch (error) {
    return fail('invalid_input', error instanceof Error ? error.message : String(error));
  }

  const courseIds = new Set(notes.map((note) => note.courseId ?? null));
  const courseId = courseIds.size === 1 ? (notes[0]?.courseId ?? null) : null;
  const sectionIds = new Set(notes.map((note) => note.sectionId ?? null));
  const sectionId =
    courseId && sectionIds.size === 1 ? (notes[0]?.sectionId ?? null) : null;

  const tag = await ensureTagCommand({ name: 'summary', namespace: 'type' });

  const created = await createNoteCommand(
    {
      title: result.title,
      doc: result.doc,
      courseId,
      sectionId,
      tagIds: tag.ok ? [tag.value.id] : [],
    },
    AI,
  );
  if (!created.ok) return created;

  await useLibraryStore.getState().refreshTags();
  return created;
}

// -- Ask ---------------------------------------------------------------------

export interface AskInput {
  /** Explicit sources. The first is the anchor when `scope` widens the search. */
  noteIds: string[];
  /**
   * How far to look. Omitted or `'note'` means "use `noteIds` as given" — no
   * search runs, which is what keeps single-note Ask exactly as it was.
   */
  scope?: AskScope;
  mode: AskMode;
  question: string;
  history: AskTurn[];
}

/** What the panel needs to render a citation: never parsed out of the answer,
 * always taken from what we actually sent. */
export interface AskSourceRef {
  noteId: string;
  title: string;
  truncated: boolean;
  /** Development-only readout; see `RetrievedSource.score`. */
  score: number;
}

export interface AskAnswer {
  answer: string;
  sources: AskSourceRef[];
  /** Relevant notes that did not fit the budget. */
  droppedCount: number;
}

/**
 * Answer a question about the open note, its course, or the whole library.
 * Reads only — it is here beside the others so that "which provider answers
 * what" has one implementation, not because it mutates anything.
 */
export async function askAboutNotesCommand(
  input: AskInput,
  options: AiRunOptions = {},
): Promise<CommandResult<AskAnswer>> {
  await useEditorStore.getState().flush();

  const scope = input.scope ?? 'note';
  let sources: (Pick<Note, 'title' | 'doc'> & {
    noteId: string;
    truncated: boolean;
    score: number;
  })[];
  let droppedCount = 0;

  if (scope === 'note') {
    const notes: Note[] = [];
    for (const noteId of input.noteIds) {
      const note = await library.getNote(noteId);
      if (note) notes.push(note);
    }
    if (!notes.length) return fail('not_found', 'open a note to ask about it');
    sources = notes.map((note) => ({
      noteId: note.id,
      title: note.title,
      doc: note.doc,
      truncated: false,
      score: 1,
    }));
  } else {
    const anchorId = input.noteIds[0];
    if (!anchorId) return fail('not_found', 'open a note to ask about it');
    const gathered = await gatherAskSourcesCommand({
      anchorNoteId: anchorId,
      scope,
      question: input.question,
      priorQuestions: input.history
        .filter((turn) => turn.role === 'user')
        .map((turn) => turn.content),
    });
    if (!gathered.ok) return gathered;
    sources = gathered.value.sources.map((source) => ({
      noteId: source.noteId,
      title: source.title,
      doc: source.doc,
      truncated: source.truncated,
      score: source.score,
    }));
    droppedCount = gathered.value.droppedCount;
  }

  const lookup = await providerFor('ask');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    const answer = await requestAnswer(
      {
        provider: lookup.provider,
        mode: input.mode,
        scope,
        sources,
        history: input.history,
        question: input.question,
        language: language(),
      },
      options,
    );
    return ok({
      answer,
      sources: sources.map(({ noteId, title, truncated, score }) => ({
        noteId,
        title,
        truncated,
        score,
      })),
      droppedCount,
    });
  } catch (error) {
    return fail('invalid_input', error instanceof Error ? error.message : String(error));
  }
}

/** Turn an answer into a note of its own — the natural next step after a
 * question worth keeping, and the only way an Ask result ever gets persisted. */
export async function saveAnswerAsNoteCommand(
  source: Note,
  question: string,
  answer: string,
): Promise<CommandResult<Note>> {
  const doc = markdownToDoc(answer);
  return createNoteCommand(
    {
      title: question.slice(0, 120),
      courseId: source.courseId,
      sectionId: source.sectionId,
      doc: {
        type: 'doc',
        content: [
          ...doc.content,
          { type: 'horizontalRule' },
          {
            type: 'paragraph',
            content: [
              {
                type: 'wikiLink',
                attrs: { title: source.title || 'Untitled', noteId: source.id },
              },
            ],
          },
        ],
      },
    },
    AI,
  );
}
