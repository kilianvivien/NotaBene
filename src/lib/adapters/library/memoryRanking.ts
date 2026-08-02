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
  return fold(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Score documents against terms, higher is closer. Terms match by prefix,
 * mirroring the `*` the Rust side appends to every token.
 *
 * Returns only documents that matched at least one term in at least one field —
 * the SQL path gets that for free from `notes_fts MATCH`.
 */
export function bm25Rank(
  docs: RankableDoc[],
  terms: string[],
  weights: readonly [number, number, number, number, number] = BM25_WEIGHTS,
): Map<string, number> {
  const scores = new Map<string, number>();
  if (!docs.length || !terms.length) return scores;

  const folded = terms.map(fold).filter(Boolean);

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

    for (const term of folded) {
      const containing = column.filter((entry) =>
        entry.tokens.some((token) => token.startsWith(term)),
      );
      if (!containing.length) continue;

      // BM25 IDF with the usual +0.5 smoothing, floored at zero so a term
      // present in every note contributes nothing rather than going negative.
      const idf = Math.max(
        0,
        Math.log(1 + (column.length - containing.length + 0.5) / (containing.length + 0.5)),
      );

      for (const entry of containing) {
        const frequency = entry.tokens.filter((token) => token.startsWith(term)).length;
        const normalized =
          (frequency * (K1 + 1)) /
          (frequency + K1 * (1 - B + (B * entry.tokens.length) / averageLength));
        scores.set(entry.id, (scores.get(entry.id) ?? 0) + weight * idf * normalized);
      }
    }
  }

  return scores;
}
