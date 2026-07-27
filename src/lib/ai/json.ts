/**
 * Getting JSON out of a model that was asked for JSON.
 *
 * The prompts say "no code fence, no prose". Models comply most of the time,
 * and the remaining fraction is large enough that a feature which fails on it
 * feels broken. So: strip a fence if there is one, and otherwise take the span
 * from the first brace to its match.
 *
 * What this does *not* do is repair malformed JSON. A response we cannot parse
 * cleanly is a response we do not trust to touch a note, and the schema behind
 * this is the third of the three guards the plan asks for.
 */
import type { z } from 'zod';

export class AiParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'AiParseError';
  }
}

/** The outermost brace-balanced span, ignoring braces inside string literals —
 * a rewritten block full of `{` in a code sample would otherwise cut short. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  return firstJsonObject(fenced?.[1] ?? text);
}

/**
 * Parse a model response against a schema. Throws `AiParseError` carrying the
 * raw text, so the UI can offer to show what actually came back — an opaque
 * "the model returned something invalid" is impossible to act on when the real
 * problem is that the endpoint answered with an HTML login page.
 */
export function parseModelJson<S extends z.ZodTypeAny>(
  schema: S,
  text: string,
): z.infer<S> {
  const candidate = extractJson(text);
  if (!candidate) {
    throw new AiParseError('the model did not return JSON', text);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(candidate);
  } catch (error) {
    throw new AiParseError(`the model returned malformed JSON: ${String(error)}`, text);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
    throw new AiParseError(
      `the model's JSON did not match the expected shape${where}: ${first?.message ?? 'unknown issue'}`,
      text,
    );
  }
  return parsed.data;
}
