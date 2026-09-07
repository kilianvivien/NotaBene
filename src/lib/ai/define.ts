/**
 * Look up a word the student is already looking at.
 *
 * The smallest AI feature in the app, and shaped by where its answer goes: into
 * a callout next to the sentence that raised the question, during a lecture,
 * while the next slide is going up. Everything here is in service of that —
 * a tight token ceiling, a near-zero temperature, and no second pass, because
 * the honest response to a bad definition is to look at it and not insert it.
 *
 * What it is not is a dictionary. A dictionary knows the word; this knows which
 * of its senses the note is in, and that is the only thing it does that a
 * dictionary cannot. So the passage travels with the term, and a term with no
 * passage behind it — one typed into the dialog — is still allowed, just
 * answered with less to go on.
 */
import { AiDefinitionResponseSchema, type AiDefinitionResponse } from '@/lib/schema';
import type { AiRunOptions } from './client';
import { runStructured } from './structured';
import { definitionPrompt } from './prompts';
import type { ResolvedProvider } from './protocols';

export interface DefinitionRequest {
  provider: ResolvedProvider;
  /** What the student selected, not necessarily the headword — the model
   * returns that. */
  term: string;
  /** The block the term was selected in. Empty when it was typed instead. */
  context: string;
  noteTitle: string;
  language: string;
}

/**
 * How much of the surrounding passage is worth sending.
 *
 * A block, not a note. The sense of a word is settled by the sentences around
 * it, and sending the whole lecture would pay for thousands of tokens per
 * lookup — on a metered key, for a feature whose whole appeal is that using it
 * five times in an hour costs nothing worth thinking about.
 */
export const MAX_CONTEXT_CHARS = 1_200;

/** Trim to the ceiling on a word boundary, so the passage does not end
 * mid-word and invite the model to guess at half a term. */
export function clampContext(context: string, limit = MAX_CONTEXT_CHARS): string {
  const trimmed = context.trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(0, limit);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > limit / 2 ? cut.slice(0, boundary) : cut).trimEnd();
}

export async function requestDefinition(
  request: DefinitionRequest,
  options: AiRunOptions = {},
): Promise<AiDefinitionResponse> {
  const term = request.term.trim();
  if (!term) throw new Error('select a word to define');

  return runStructured(
    {
      provider: request.provider,
      messages: definitionPrompt({
        term,
        context: clampContext(request.context),
        noteTitle: request.noteTitle,
        language: request.language,
      }),
      // Two sentences and a headword. The ceiling is generous for that and
      // still small enough that a runaway answer stops being expensive.
      maxTokens: 700,
      // A definition is not a creative act. This is the same call the student
      // may run twice on the same word, and getting two different answers
      // would read as the feature being unreliable rather than as variety.
      temperature: 0.1,
    },
    AiDefinitionResponseSchema,
    options,
  );
}
