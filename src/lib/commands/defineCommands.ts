/**
 * Define a word from the note, with a model.
 *
 * A read, not a mutation, and deliberately not a write command: nothing is
 * changed by asking what a word means, and the block that eventually lands in
 * the note is inserted through the editor like any other — so it autosaves,
 * undoes and versions exactly as if the student had typed it.
 *
 * The passage is the caller's to supply rather than something looked up here.
 * What decides the sense of a word is the paragraph it sits in, and only the
 * editor knows which paragraph the caret was in; loading the note and guessing
 * would send the wrong thousand characters.
 */
import { z } from 'zod';
import { requestDefinition, type AiRunOptions } from '@/lib/ai';
import type { AiDefinitionResponse } from '@/lib/schema';
import { aiFailure, language, providerFor } from './aiCommands';
import { fail, ok, type CommandResult } from './types';

const DefineInput = z.object({
  /** What was selected. Not the headword — the model returns that. */
  term: z.string().trim().min(1).max(120),
  /** The block it was selected in, or empty when it was typed by hand. */
  context: z.string().max(20_000).default(''),
  noteTitle: z.string().max(300).default(''),
});
export type DefineTermInput = z.input<typeof DefineInput>;

/**
 * A selection long enough to be a sentence is not a term.
 *
 * The dialog stops this before the request, but the guard belongs here too: MCP
 * and the agent do not share the dialog, and "define this" pointed at three
 * paragraphs is a summarisation request wearing the wrong feature — expensive,
 * and answered with a definition of nothing.
 */
export const MAX_TERM_WORDS = 8;

export async function defineTermCommand(
  input: DefineTermInput,
  options: AiRunOptions = {},
): Promise<CommandResult<AiDefinitionResponse>> {
  const parsed = DefineInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'select a word to define', parsed.error.issues);
  }
  if (parsed.data.term.split(/\s+/).length > MAX_TERM_WORDS) {
    return fail('invalid_input', 'that is a passage, not a term');
  }

  const lookup = await providerFor('define');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    return ok(
      await requestDefinition(
        {
          provider: lookup.provider,
          term: parsed.data.term,
          context: parsed.data.context,
          noteTitle: parsed.data.noteTitle,
          language: language(),
        },
        options,
      ),
    );
  } catch (error) {
    return aiFailure(error, options.signal);
  }
}
