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
    return this.candidates(prefix, 1)[0] ?? null;
  }

  /**
   * Up to `limit` entries that complete `prefix`, best first, each adding at
   * least `minRest` code points. Filtering by length *before* choosing is
   * what lets a longer word win when the best one would save a single letter.
   */
  candidates(prefix: string, limit: number, minRest = 1): CompletionEntry[] {
    const key = foldKey(prefix);
    if (!key || limit <= 0) return [];
    const length = codePointLength(key) + Math.max(1, minRest) - 1;

    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.entries[middle]?.key ?? '') < key) low = middle + 1;
      else high = middle;
    }

    const found: CompletionEntry[] = [];
    for (let index = low, scanned = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      if (!entry.key.startsWith(key)) break;
      if (++scanned > MAX_SCAN) break;
      if (codePointLength(entry.key) <= length) continue;
      found.push(entry);
    }
    return found.sort(byRank).slice(0, limit);
  }
}

/** Heavier first; on a tie the shorter term, then a stable alphabetical order
 * so cycling through alternatives always visits them the same way. */
export function byRank(a: CompletionEntry, b: CompletionEntry): number {
  return b.weight - a.weight || a.key.length - b.key.length || (a.key < b.key ? -1 : 1);
}

/** Each use of a word in the open note counts this much: the lecture being
 * written is the best predictor of the next word, better than last month's. */
const NOTE_WEIGHT = 4;
/** Each earlier Tab on a word, up to `LEARN_CAP` of them. */
const LEARN_WEIGHT = 8;
const LEARN_CAP = 10;

export interface RankSources {
  /** The course's (or library's) index; its rejected list silences the rest. */
  course: CompletionIndex | null;
  /** The open note's own words, uses as weight. */
  note?: CompletionIndex | null;
  /** How many times a folded key was accepted before. */
  learned?: (key: string) => number;
}

/**
 * The suggestions for `prefix`, best first, drawn from every source.
 *
 * One entry per folded key. The course's spelling wins where both know the
 * word, because it is the one the student curated or used most; the note
 * adds weight, and so does having taken the word with Tab before.
 */
export function rankCompletions(
  sources: RankSources,
  prefix: string,
  limit: number,
  minRest = 1,
): CompletionEntry[] {
  // Wider than `limit`, so a word the note or the student's habits lift can
  // overtake ones the course alone ranked higher.
  const wide = Math.max(limit * 4, 16);
  const byKey = new Map<string, CompletionEntry>();
  for (const entry of sources.course?.candidates(prefix, wide, minRest) ?? []) {
    byKey.set(entry.key, { ...entry });
  }
  for (const entry of sources.note?.candidates(prefix, wide, minRest) ?? []) {
    if (sources.course?.isRejected(entry.term)) continue;
    const known = byKey.get(entry.key);
    if (known) known.weight += NOTE_WEIGHT * entry.weight;
    else byKey.set(entry.key, { ...entry, weight: NOTE_WEIGHT * entry.weight });
  }
  if (sources.learned) {
    for (const entry of byKey.values()) {
      entry.weight += LEARN_WEIGHT * Math.min(LEARN_CAP, sources.learned(entry.key));
    }
  }
  return [...byKey.values()].sort(byRank).slice(0, limit);
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
