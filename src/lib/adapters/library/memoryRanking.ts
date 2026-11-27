/**
 * BM25 for the in-memory adapter.
 *
 * The desktop build ranks in SQLite (`bm25(notes_fts, …)`); this is the same
 * formula over the same five pseudo-columns, so `pnpm dev` and Vitest rank
 * notes the way the real app does. It is emphatically *not* an attempt to
 * reproduce SQLite's numbers — the smoothing differs, and FTS5's own docs make
 * no promise about absolute values. Tests assert ordering; anything that
 * compares a score to a constant is testing the wrong thing.
 *
 * Fields are indexed in schema order: title, plainText, tags, course,
 * attachments.
 */
import { fold } from '@/lib/search/fold';
import type { NoteSearchTerm, NoteTextExpression } from './LibraryAdapter';

export type RankedFields = [string, string, string, string, string];

/** Mirrors `BM25_WEIGHTS` in `src-tauri/src/db/notes.rs`. Move them together. */
export const BM25_WEIGHTS: readonly [number, number, number, number, number] = [
  10, 1, 6, 3, 0.5,
];

const K1 = 1.2;
const B = 0.75;

export interface RankableDoc {
  id: string;
  fields: RankedFields;
}

function tokenize(value: string): string[] {
  return fold(value)
    .split(/[^\p{L}\p{N}\p{Co}]+/u)
    .filter(Boolean);
}

interface IndexedTerm {
  tokens: string[];
  source: NoteSearchTerm;
}

function indexTerm(term: NoteSearchTerm): IndexedTerm {
  return { tokens: tokenize(term.text), source: term };
}

function matchesAt(tokens: string[], term: IndexedTerm, start: number): boolean {
  return term.tokens.every((word, offset) => {
    const token = tokens[start + offset];
    return !term.source.phrase && offset === term.tokens.length - 1
      ? token?.startsWith(word) === true
      : token === word;
  });
}

export function compileNoteText(
  expression: NoteTextExpression,
): (fields: RankedFields) => NoteSearchTerm[] | null {
  const indexTerms = (terms: NoteSearchTerm[]) =>
    terms.map(indexTerm).filter((term) => term.tokens.length > 0);
  const groups = expression.groups.filter((group) => group.length > 0).map(indexTerms);
  const exclude = indexTerms(expression.exclude);

  return (fields) => {
    const columns = fields.map(tokenize);
    // FTS5 requires a phrase to stay inside a column. Individual AND terms
    // can match different columns, such as one in the title and one in the body.
    const hit = (term: IndexedTerm) =>
      columns.some((tokens) => tokens.some((_, start) => matchesAt(tokens, term, start)));
    if (exclude.some(hit)) return null;
    const matched = groups.filter((group) => group.length > 0 && group.every(hit));
    if (groups.length && !matched.length) return null;
    return matched.flat().map(({ source }) => source);
  };
}

/**
 * Score documents against terms, higher is closer. String inputs are literal
 * prefix terms, the form used by task search.
 *
 * When given complete matches for a grouped query, count only their hits in
 * the score. FTS5 ignores hits from an unsatisfied OR branch.
 */
export function bm25Rank(
  docs: RankableDoc[],
  terms: (string | NoteSearchTerm)[],
  weights: readonly [number, number, number, number, number] = BM25_WEIGHTS,
  matches?: ReadonlyMap<string, NoteSearchTerm[]>,
): Map<string, number> {
  const scores = new Map<string, number>();
  if (!docs.length || !terms.length) return scores;

  const indexed = terms
    .map((term) => {
      if (typeof term !== 'string') return indexTerm(term);
      const folded = fold(term);
      return {
        tokens: folded ? [folded] : [],
        source: { text: term, phrase: false },
      };
    })
    .filter((term) => term.tokens.length > 0);

  // One field at a time, so each keeps its own average length. That is the
  // whole reason a title weight buys anything: a hit in a three-word title says
  // more than the same hit in a thousand-word body.
  for (let field = 0; field < weights.length; field += 1) {
    const weight = weights[field] ?? 0;
    if (!weight) continue;

    const column = docs.map((doc) => ({
      id: doc.id,
      tokens: tokenize(doc.fields[field] ?? ''),
    }));
    const averageLength =
      column.reduce((sum, entry) => sum + entry.tokens.length, 0) / column.length || 1;

    for (const term of indexed) {
      const containing = column
        .map((entry) => ({
          ...entry,
          frequency: entry.tokens.filter((_, start) =>
            matchesAt(entry.tokens, term, start),
          ).length,
        }))
        .filter((entry) => entry.frequency > 0);
      if (!containing.length) continue;

      // BM25 IDF with the usual +0.5 smoothing, floored at zero so a term
      // present in every note contributes nothing rather than going negative.
      const idf = Math.max(
        0,
        Math.log(
          1 + (column.length - containing.length + 0.5) / (containing.length + 0.5),
        ),
      );

      for (const { id, tokens, frequency } of containing) {
        if (matches && !matches.get(id)?.includes(term.source)) continue;
        const normalized =
          (frequency * (K1 + 1)) /
          (frequency + K1 * (1 - B + (B * tokens.length) / averageLength));
        scores.set(id, (scores.get(id) ?? 0) + weight * idf * normalized);
      }
    }
  }

  return scores;
}
