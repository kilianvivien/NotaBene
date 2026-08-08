/**
 * Synthesis: one or more notes in, a new note out.
 *
 * A new note rather than an edit, always. A summary that overwrote its source
 * would be the one AI action a student could not undo by not accepting it, and
 * the whole point of a revision sheet is to sit beside the lecture note, not
 * replace it.
 */
import { docToMarkdown, markdownToDoc } from '@/editor/markdown';
import { AiSynthesisResponseSchema, type Note, type NoteDoc } from '@/lib/schema';
import type { AiRunOptions } from './client';
import { runStructured } from './structured';
import { synthesisPrompt, type SynthesisStyle } from './prompts';
import type { ResolvedProvider } from './protocols';

export type { SynthesisStyle };

/**
 * How many notes one AI feature may be pointed at.
 *
 * Not a model limit — `MAX_INPUT_TOKENS` is that, and it is a refusal ceiling.
 * This is the point past which the *output* stops being useful: a revision
 * sheet distilled from twenty lectures is an index, and a podcast read from
 * them is an afternoon. Twelve notes at a couple of thousand tokens each also
 * happens to be where the cheaper models start losing the middle of the
 * prompt, so the two limits agree.
 */
export const MAX_AI_SOURCES = 10;

/**
 * What the sources may take, in tokens.
 *
 * Deliberately below `MAX_INPUT_TOKENS`: every synthesis bills the whole
 * prompt against the student's own key, and a model writes a better sheet from
 * a focused 48k of context than from 150k. `MAX_AI_SOURCES` binds first for
 * ordinary class notes; this catches the selection of ten imported PDFs.
 */
export const AI_SOURCE_BUDGET_TOKENS = 48_000;

/** Why a selection was refused, so the dialog can say so in the student's
 * language rather than surfacing an English string from the transport. */
export type AiSourceLimit = 'too_many_notes' | 'over_budget';

/**
 * Check a selection before a request is built.
 *
 * Returns `null` when the selection is fine. Lives beside the request it
 * guards so the dialog and the command share one rule — a dialog that lets you
 * press the button and a command that then refuses is worse than either.
 */
export function checkSourceLimits(
  sources: Pick<Note, 'doc'>[],
  estimate: (text: string) => number,
): { limit: AiSourceLimit; notes: number; tokens: number } | null {
  const tokens = sources.reduce(
    (total, note) => total + estimate(docToMarkdown(note.doc)),
    0,
  );
  if (sources.length > MAX_AI_SOURCES) {
    return { limit: 'too_many_notes', notes: sources.length, tokens };
  }
  if (tokens > AI_SOURCE_BUDGET_TOKENS) {
    return { limit: 'over_budget', notes: sources.length, tokens };
  }
  return null;
}

export interface SynthesisRequest {
  provider: ResolvedProvider;
  sources: Pick<Note, 'id' | 'title' | 'doc'>[];
  style: SynthesisStyle;
  /** The student's own brief, when `style` is `custom`. */
  instructions?: string;
  language: string;
}

export interface SynthesisResult {
  title: string;
  doc: NoteDoc;
}

export async function requestSynthesis(
  request: SynthesisRequest,
  options: AiRunOptions = {},
): Promise<SynthesisResult> {
  if (!request.sources.length) throw new Error('select at least one note to summarize');
  // The custom style has no intent of its own — without a brief the model would
  // be asked for "" and would invent the assignment.
  if (request.style === 'custom' && !request.instructions?.trim()) {
    throw new Error('write what this note should be');
  }

  const response = await runStructured(
    {
      provider: request.provider,
      messages: synthesisPrompt({
        style: request.style,
        sources: request.sources.map((note) => ({
          title: note.title,
          markdown: docToMarkdown(note.doc),
        })),
        language: request.language,
        instructions: request.instructions,
      }),
      maxTokens: 8_000,
      temperature: 0.3,
    },
    AiSynthesisResponseSchema,
    options,
  );
  const doc = markdownToDoc(response.markdown);

  return {
    title: response.title.trim(),
    doc: withSourceLinks(doc, request.sources),
  };
}

/**
 * Append the "from" section.
 *
 * The links are built here, from note ids we already hold, rather than asked
 * for in the prompt — a model inventing a `[[link]]` to a note that does not
 * exist would leave the student clicking through to a create-new-note dialog
 * for a lecture they never wrote.
 */
function withSourceLinks(
  doc: NoteDoc,
  sources: Pick<Note, 'id' | 'title'>[],
): NoteDoc {
  const links = sources.map((note) => ({
    type: 'listItem',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'wikiLink',
            attrs: { title: note.title || 'Untitled', noteId: note.id },
          },
        ],
      },
    ],
  }));

  return {
    type: 'doc',
    content: [
      ...doc.content,
      { type: 'horizontalRule' },
      { type: 'bulletList', content: links },
    ],
  };
}
