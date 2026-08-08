/**
 * Getting JSON out of a model that was asked for JSON.
 *
 * The prompts say "a single JSON object, no code fence, no prose". A frontier
 * model complies. A seven-billion-parameter model running on a student's
 * laptop complies most of the time, and the rest of the time it thinks out
 * loud first, wraps the answer in a fence, puts a comma after the last field,
 * or writes a newline inside a string instead of `\n` — none of which is a bad
 * answer, only a badly typed one.
 *
 * So this reads in widening circles: strip the reasoning trace, try each
 * fenced block, then the first brace-balanced span, then the last one; and if
 * a candidate is nearly JSON, fix the punctuation and try again.
 *
 * What it never does is invent content. Every repair here is structural —
 * delimiters and escaping, never a value — and whatever comes out is still
 * parsed by the Zod schema before it can touch a note. That schema, not the
 * strictness of `JSON.parse`, is the trust boundary; keep it that way.
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

/** Reasoning traces. Every small local model worth running is a reasoning
 * model now, and its thoughts routinely contain braces — a plan for the JSON
 * it is about to write, or an example of it. Taken as the answer, that is a
 * parse failure at best and the *wrong* answer at worst. */
const THOUGHTS = /<(think|thinking|reasoning|analysis|scratchpad)>[\s\S]*?<\/\1>/gi;

/** The outermost brace-balanced span from `start`, ignoring braces inside
 * string literals — a rewritten block full of `{` in a code sample would
 * otherwise cut short. */
function balancedFrom(text: string, start: number): string | null {
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

/**
 * Every complete top-level object in the text, in the order they appear.
 *
 * More than one is normal from a chatty model: "I'll use this shape: {…} — so
 * here is the note: {…}". The first span is then an example and the answer is
 * the last, which is why the search does not stop at one.
 */
function jsonObjects(text: string): string[] {
  const found: string[] = [];
  let index = text.indexOf('{');
  while (index !== -1) {
    const span = balancedFrom(text, index);
    if (!span) break;
    found.push(span);
    index = text.indexOf('{', index + span.length);
  }
  return found;
}

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/```(?:json\w*)?\s*\n?([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}

/** Every reading of the response worth trying, best first. A fence is the
 * strongest signal the model gave about where its answer starts, so those come
 * before the bare spans. */
function candidates(text: string): string[] {
  const cleaned = text.replaceAll(THOUGHTS, ' ');
  const found: string[] = [];
  for (const block of fencedBlocks(cleaned)) {
    found.push(block, ...jsonObjects(block));
  }
  found.push(...jsonObjects(cleaned));
  return [...new Set(found.filter(Boolean))];
}

/**
 * Repair the punctuation of something that is trying to be JSON.
 *
 * Two failures account for nearly all of it. A trailing comma before a closing
 * brace, which is legal in JavaScript and in every model's training data. And
 * a literal newline inside a string, which is what you get when a model writes
 * a Markdown document into a `"markdown"` field the way it would write it to a
 * page — the content is perfectly good, and JSON says it must be `\n`.
 *
 * Single pass, string-aware, and incapable of changing a value: a control
 * character becomes its escape, a comma before a closing bracket goes away.
 */
function repairPunctuation(text: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        out.push(char);
        continue;
      }
      if (char === '\\') {
        escaped = true;
        out.push(char);
        continue;
      }
      if (char === '"') {
        inString = false;
        out.push(char);
        continue;
      }
      const code = char.codePointAt(0)!;
      if (code < 0x20) {
        out.push(
          char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : '',
        );
        continue;
      }
      out.push(char);
      continue;
    }

    if (char === '"') {
      inString = true;
      out.push(char);
      continue;
    }
    if (char === ',') {
      // Look past whitespace: a comma followed by `}` or `]` is the one the
      // model should not have written.
      const rest = text.slice(index + 1);
      const next = rest.trimStart()[0];
      if (next === '}' || next === ']') continue;
    }
    out.push(char);
  }

  return out.join('');
}

/** Curly *double* quotes as delimiters — a model that formatted its answer for
 * a reader rather than for a parser. Tried only after the text has already
 * failed to parse, so the cost to prose that legitimately contains one is
 * paid only on a response that was otherwise dead.
 *
 * Single quotes are deliberately left alone: they are never JSON delimiters,
 * so straightening them could not rescue a parse — it would only rewrite the
 * apostrophe in `l’équation` inside a value, on the exact fallback path that
 * exists for small models writing French notes. */
function straightenQuotes(text: string): string {
  return text.replaceAll(/[“”]/g, '"');
}

/** The candidate span, as it stands and then repaired. Ordered so an untouched
 * response always wins: a model that answered correctly is never reinterpreted. */
function readings(candidate: string): string[] {
  return [
    ...new Set([
      candidate,
      repairPunctuation(candidate),
      repairPunctuation(straightenQuotes(candidate)),
    ]),
  ];
}

/** The first brace-balanced span of a response, after the thinking is stripped.
 * Exported for the tests and for callers that want to look before they parse. */
export function extractJson(text: string): string | null {
  return candidates(text)[0] ?? null;
}

/**
 * Parse a model response against a schema. Throws `AiParseError` carrying the
 * raw text, so the UI can offer to show what actually came back — an opaque
 * "the model returned something invalid" is impossible to act on when the real
 * problem is that the endpoint answered with an HTML login page.
 *
 * A candidate that parses but does not fit the schema does not end the search:
 * the thinking of a small model often contains a plausible-looking half-object,
 * and the answer underneath it deserves its turn.
 */
export function parseModelJson<S extends z.ZodTypeAny>(
  schema: S,
  text: string,
): z.infer<S> {
  const found = candidates(text);
  if (!found.length) {
    throw new AiParseError('the model did not return JSON', text);
  }

  let shapeProblem: string | null = null;
  let syntaxProblem: string | null = null;

  for (const candidate of found) {
    for (const reading of readings(candidate)) {
      let payload: unknown;
      try {
        payload = JSON.parse(reading);
      } catch (error) {
        syntaxProblem ??= String(error);
        continue;
      }

      const parsed = schema.safeParse(payload);
      if (parsed.success) return parsed.data;

      const first = parsed.error.issues[0];
      const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
      shapeProblem ??= `${where}: ${first?.message ?? 'unknown issue'}`;
    }
  }

  if (shapeProblem) {
    throw new AiParseError(
      `the model's JSON did not match the expected shape${shapeProblem}`,
      text,
    );
  }
  throw new AiParseError(
    `the model returned malformed JSON: ${syntaxProblem ?? 'unparseable'}`,
    text,
  );
}
