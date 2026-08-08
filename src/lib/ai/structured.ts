/**
 * A call that has to come back as a document, not as prose.
 *
 * Six features need one — rewrite, reformat, synthesis, mind map, flashcards,
 * podcast script — and every one of them used to be one bad character away
 * from "the model did not return JSON" with nothing behind it. `json.ts` now
 * reads a messy answer generously; this adds the other half, for the answer no
 * amount of reading can rescue: show the model what it wrote, name the
 * problem, and ask once more.
 *
 * The retry is the difference between a small local model being usable for
 * these features and not. It is also invisible to a model that gets it right
 * the first time, which is every frontier model and most local ones — the
 * second call happens only after a parse has already failed.
 */
import type { z } from 'zod';
import { runAi, type AiRunOptions } from './client';
import { AiParseError, parseModelJson } from './json';
import { jsonRepairPrompt } from './prompts';
import type { AiCall } from './protocols';

/** `json` and `stream` are not the caller's to choose here: a structured call
 * asks for JSON, and it cannot stream because there is nothing to show until
 * the document is complete. */
export type StructuredCall = Omit<AiCall, 'json' | 'stream'>;

export async function runStructured<S extends z.ZodTypeAny>(
  call: StructuredCall,
  schema: S,
  options: AiRunOptions = {},
): Promise<z.infer<S>> {
  const raw = await runAi({ ...call, json: true, stream: false }, options);
  try {
    return parseModelJson(schema, raw);
  } catch (error) {
    // Only a parse failure earns a second try. A 401, a timeout, or a cancel
    // will fail exactly the same way again, and the retry would cost a student
    // on a metered key twice for one mistake.
    if (!(error instanceof AiParseError)) throw error;
    if (options.signal?.aborted) throw error;
    // Nothing came back at all. There is no answer to show the model, and an
    // empty assistant turn is a 400 from some providers — which would replace
    // "the model returned nothing" with something far less true.
    if (!raw.trim()) throw error;

    const second = await runAi(
      {
        ...call,
        messages: jsonRepairPrompt(call.messages, raw, error.message),
        // The first answer was creative enough. Asking for the same content
        // again is a transcription task, and the providers that refuse a
        // temperature drop it in `protocols.ts`.
        temperature: 0,
        json: true,
        stream: false,
      },
      options,
    );

    try {
      return parseModelJson(schema, second);
    } catch (retried) {
      // Report the second failure: it is the one the raw text in the error
      // belongs to, and a student who opens "show me what came back" should
      // see what actually came back last.
      throw retried instanceof AiParseError ? retried : error;
    }
  }
}
