/**
 * A course's vocabulary, read out of its own notes.
 *
 * Pure and synchronous, so it can be tested without a store; the cache runs it
 * when the editor is idle, never on a keystroke. What comes out is ranked,
 * not filtered to "technical" words: the notes already are the course's
 * language, and a completer that only knew jargon would be no help with the
 * long ordinary words a student types forty times a lecture.
 *
 * Two thresholds decide what counts. A word must be long enough that
 * completing it saves typing, and it must recur — across notes, or often
 * within one — because a word seen once is as likely to be a typo as a term.
 * A typo that recurs anyway is what the course's rejected list is for.
 */
import type { NoteText } from '@/lib/adapters';
import { STOPWORD_KEYS } from './stopwords';
import { codePointLength, foldKey, isLowerCase, wordsIn } from './text';

export interface HarvestOptions {
  /** Shortest word worth completing, in code points. */
  minLength?: number;
  /** A word in at least this many notes is kept… */
  minNotes?: number;
  /** …and so is one used at least this often in total. */
  minCount?: number;
  /** Most terms kept, best first. */
  limit?: number;
  /**
   * Words that count as the course's own regardless of frequency: tag names,
   * and anything else the student has already singled out. Each is kept if it
   * is long enough and not a stop word, even when it occurs nowhere.
   */
  keyTerms?: readonly string[];
}

export interface HarvestedTerm {
  /** The spelling to suggest. */
  term: string;
  /** `foldKey(term)`. */
  key: string;
  /** Occurrences across every note. */
  count: number;
  /** Distinct notes it occurs in. */
  notes: number;
  score: number;
}

export const HARVEST_DEFAULTS = {
  minLength: 6,
  minNotes: 2,
  minCount: 3,
  limit: 5_000,
} as const;

/** Stricter thresholds for a note with no course, harvested from the whole
 * library: a word two unrelated notes happen to share is not vocabulary. */
export const LIBRARY_HARVEST = {
  minLength: 6,
  minNotes: 3,
  minCount: 5,
  limit: 5_000,
} as const;

/** A title names what the note is about, so its words are weighted as if
 * they had been written this many more times. */
const TITLE_WEIGHT = 3;
const KEY_TERM_BONUS = 10;

interface Tally {
  count: number;
  notes: number;
  lastNote: string;
  title: boolean;
  key: boolean;
  spellings: Map<string, number>;
}

/** Numbers, dates and the like: "2026", "12-14". Letters are required. */
const HAS_LETTER = /\p{L}/u;

/**
 * Which spelling of a word to suggest.
 *
 * A word capitalised only at the start of sentences is a lower-case word, so
 * any lower-case spelling wins over capitalised ones. Among what is left the
 * most frequent wins; a tie goes to the spelling with more accents, because
 * "élément" and "element" are the same word with and without the student's
 * care, never two words.
 */
function preferredSpelling(spellings: Map<string, number>): string {
  const entries = [...spellings.entries()];
  const lower = entries.filter(([spelling]) => isLowerCase(spelling));
  const pool = lower.length ? lower : entries;
  pool.sort(
    ([a, countA], [b, countB]) =>
      countB - countA || accentCount(b) - accentCount(a) || a.localeCompare(b),
  );
  return pool[0]?.[0] ?? '';
}

function accentCount(value: string): number {
  return value.normalize('NFD').replace(/[^\p{M}]/gu, '').length;
}

/**
 * A harvest in progress. Notes are fed in one at a time so the cache can
 * yield to the editor between them; `finish` ranks what was gathered.
 */
export interface Harvester {
  add(source: NoteText): void;
  finish(): HarvestedTerm[];
}

export function createHarvester(options: HarvestOptions = {}): Harvester {
  const minLength = options.minLength ?? HARVEST_DEFAULTS.minLength;
  const minNotes = options.minNotes ?? HARVEST_DEFAULTS.minNotes;
  const minCount = options.minCount ?? HARVEST_DEFAULTS.minCount;
  const limit = options.limit ?? HARVEST_DEFAULTS.limit;

  const tallies = new Map<string, Tally>();
  // A lecture repeats its words, so each spelling is folded and judged once.
  // Folding is per code point and dominates the cost of a harvest otherwise.
  const judged = new Map<string, string | null>();
  const keyFor = (word: string): string | null => {
    // UTF-16 length is never below the code point length, so this rejects
    // the short words — most of any text — before anything costs more.
    if (word.length < minLength) return null;
    let key = judged.get(word);
    if (key === undefined) {
      const folded = foldKey(word);
      key =
        codePointLength(word) >= minLength &&
        HAS_LETTER.test(word) &&
        !STOPWORD_KEYS.has(folded)
          ? folded
          : null;
      judged.set(word, key);
    }
    return key;
  };

  const record = (word: string, noteId: string, weight: number, inTitle: boolean) => {
    const key = keyFor(word);
    if (key === null) return;
    let tally = tallies.get(key);
    if (!tally) {
      tally = {
        count: 0,
        notes: 0,
        lastNote: '',
        title: false,
        key: false,
        spellings: new Map(),
      };
      tallies.set(key, tally);
    }
    tally.count += weight;
    if (tally.lastNote !== noteId) {
      tally.notes += 1;
      tally.lastNote = noteId;
    }
    if (inTitle) tally.title = true;
    tally.spellings.set(word, (tally.spellings.get(word) ?? 0) + 1);
  };

  return {
    add(source) {
      for (const word of wordsIn(source.title))
        record(word, source.id, TITLE_WEIGHT, true);
      for (const word of wordsIn(source.plainText)) record(word, source.id, 1, false);
    },

    finish() {
      for (const keyTerm of options.keyTerms ?? []) {
        for (const word of wordsIn(keyTerm)) {
          const key = keyFor(word);
          if (key === null) continue;
          const tally = tallies.get(key);
          if (tally) {
            tally.key = true;
          } else {
            tallies.set(key, {
              count: 0,
              notes: 0,
              lastNote: '',
              title: false,
              key: true,
              spellings: new Map([[word, 1]]),
            });
          }
        }
      }

      const terms: HarvestedTerm[] = [];
      for (const [key, tally] of tallies) {
        const recurs = tally.notes >= minNotes || tally.count >= minCount;
        if (!recurs && !tally.key && !tally.title) continue;
        terms.push({
          term: preferredSpelling(tally.spellings),
          key,
          count: tally.count,
          notes: tally.notes,
          score: tally.count + 2 * tally.notes + (tally.key ? KEY_TERM_BONUS : 0),
        });
      }

      terms.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
      return terms.slice(0, limit);
    },
  };
}

export function harvestVocabulary(
  sources: readonly NoteText[],
  options: HarvestOptions = {},
): HarvestedTerm[] {
  const harvester = createHarvester(options);
  for (const source of sources) harvester.add(source);
  return harvester.finish();
}
