/**
 * The lookup the editor asks on a keystroke: "best term starting with this".
 *
 * A sorted array and a binary search, because this runs inside a ProseMirror
 * transaction and has to cost nothing. Keys are folded, so "theor" finds
 * "théorème" — and because the suggestion is the whole stored spelling, taking
 * it also puts back the accents the student skipped while typing fast.
 */
import type { CourseTerm } from '@/lib/schema';
import type { HarvestedTerm } from './harvest';
import { codePointLength, foldKey, normalizeTerm } from './text';

export interface CompletionEntry {
  term: string;
  key: string;
  weight: number;
  /** On the course's own list, rather than found in the notes. */
  curated: boolean;
}

/** Past this many candidates sharing a prefix the best one has long been
 * found; the cap keeps a one-letter prefix from walking the whole index. */
const MAX_SCAN = 256;

/** Curated terms outrank anything harvested, whatever its frequency: the
 * student said so. */
const CURATED_WEIGHT = 1_000_000;

export class CompletionIndex {
  private readonly entries: CompletionEntry[];
  /** Folded keys the student asked never to see, for `isRejected`. */
  private readonly rejected: ReadonlySet<string>;

  constructor(entries: CompletionEntry[], rejected: ReadonlySet<string> = new Set()) {
    this.entries = [...entries].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    this.rejected = rejected;
  }

  get size(): number {
    return this.entries.length;
  }

  isRejected(word: string): boolean {
    return this.rejected.has(foldKey(normalizeTerm(word)));
  }

  /**
   * The best entry longer than `prefix` that starts with it, or `null`.
   * Ties go to the shorter term: of "cellule" and "cellulaire" at equal
   * weight, the one that is closer to what was typed is the likelier word.
   */
  complete(prefix: string): CompletionEntry | null {
    const key = foldKey(prefix);
    if (!key) return null;
    const length = codePointLength(key);

    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.entries[middle]?.key ?? '') < key) low = middle + 1;
      else high = middle;
    }

    let best: CompletionEntry | null = null;
    for (let index = low, scanned = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      if (!entry.key.startsWith(key)) break;
      if (++scanned > MAX_SCAN) break;
      if (codePointLength(entry.key) <= length) continue;
      if (
        !best ||
        entry.weight > best.weight ||
        (entry.weight === best.weight && entry.key.length < best.key.length)
      ) {
        best = entry;
      }
    }
    return best;
  }
}

/**
 * Combine what the notes say with what the student decided.
 *
 * One entry per folded key. An accepted term replaces the harvested spelling
 * of the same word — that is how "Schrodinger" in three hurried lectures
 * becomes "Schrödinger" once the student has fixed it once — and a rejected
 * term removes the word outright.
 */
export function buildCompletionIndex(
  harvested: readonly HarvestedTerm[],
  curated: readonly Pick<CourseTerm, 'term' | 'status'>[],
): CompletionIndex {
  const rejected = new Set<string>();
  const accepted = new Map<string, string>();
  for (const entry of curated) {
    const term = normalizeTerm(entry.term);
    const key = foldKey(term);
    if (!key) continue;
    if (entry.status === 'rejected') rejected.add(key);
    else accepted.set(key, term);
  }

  const byKey = new Map<string, CompletionEntry>();
  for (const entry of harvested) {
    if (rejected.has(entry.key)) continue;
    byKey.set(entry.key, {
      term: entry.term,
      key: entry.key,
      weight: entry.score,
      curated: false,
    });
  }
  for (const [key, term] of accepted) {
    // Accepted wins over rejected: a student who later adds a word they once
    // hid meant the second decision.
    rejected.delete(key);
    byKey.set(key, {
      term,
      key,
      weight: CURATED_WEIGHT + (byKey.get(key)?.weight ?? 0),
      curated: true,
    });
  }

  return new CompletionIndex([...byKey.values()], rejected);
}
