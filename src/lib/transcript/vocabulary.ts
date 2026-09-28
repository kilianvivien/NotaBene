/**
 * The lecture's own words, put to work on its transcript (plan §10.3).
 *
 * A recogniser mishears exactly the words a course is made of — "thylakoïdes"
 * comes back "thyloïdes", "photosynthèse" as "photo santes" — and those are
 * the words the student already has: typed into the lecture note while it was
 * being recorded, harvested from the course's notes, curated as its terms.
 * They are used twice:
 *
 * 1. **Before**, as the engine's hints (Apple's contextual strings, Mistral's
 *    `context_bias`): curated terms first, then the lecture note's own words,
 *    then the course's.
 * 2. **After**, on the words the engine was unsure of — the highlighted ones.
 *    A doubtful word (or two adjacent ones) close enough to a term is given
 *    the term's spelling. It stays highlighted: the vocabulary is evidence,
 *    not proof, and the student still gets the last word.
 *
 * Only doubtful words are touched. A confident "cycles" next to the term
 * "cycle" is a plural, not a mistake.
 */
import type { CourseTerm, TranscriptWord } from '@/lib/schema';
import {
  codePointLength,
  createHarvester,
  foldKey,
  type HarvestedTerm,
} from '@/lib/vocabulary';
import { REVIEW_CONFIDENCE } from './document';
import type { TranscriptParagraph } from './paragraphs';

export interface LectureTerm {
  term: string;
  /** `foldKey(term)` with everything but letters and digits removed, so
   * "photo santes" can meet "photosynthèse". */
  key: string;
  source: 'curated' | 'note' | 'course';
}

/** Shorter than this, a near miss is as likely another word as a typo. */
const MIN_TERM_LENGTH = 5;

/** How much of a term may differ and still be it: "thyloïdes" is two
 * letters from the eleven of "thylakoïdes". */
const MAX_DISTANCE_RATIO = 0.25;

/** Letters and digits only: "tous," and "photo santes" compare as words. */
function compactKey(value: string): string {
  return foldKey(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The vocabulary for one lecture, best first: the course's accepted terms,
 * the words of the note the lecture was recorded in, then the course's
 * harvest. Rejected terms are never included — a term on that list is one
 * the student said is wrong.
 */
export function lectureVocabulary(input: {
  curated: CourseTerm[];
  note: { id: string; title: string; plainText: string };
  harvested: HarvestedTerm[];
}): LectureTerm[] {
  const rejected = new Set(
    input.curated
      .filter((term) => term.status !== 'accepted')
      .map((term) => compactKey(term.term)),
  );
  const seen = new Set<string>();
  const terms: LectureTerm[] = [];
  const add = (term: string, source: LectureTerm['source']) => {
    const key = compactKey(term);
    if (codePointLength(key) < MIN_TERM_LENGTH || seen.has(key) || rejected.has(key)) {
      return;
    }
    seen.add(key);
    terms.push({ term, key, source });
  };

  for (const term of input.curated) {
    if (term.status === 'accepted') add(term.term, 'curated');
  }
  // One note, so a word the student typed once is already a word of this
  // lecture: no recurrence required, unlike the course harvest.
  const noteHarvest = createHarvester({ minNotes: 1, minCount: 1, limit: 500 });
  noteHarvest.add(input.note);
  for (const term of noteHarvest.finish()) add(term.term, 'note');
  for (const term of input.harvested) add(term.term, 'course');
  return terms;
}

/** What goes to the engine as hints: the head of the vocabulary. */
export function hintTerms(vocabulary: LectureTerm[], max: number): string[] {
  return vocabulary.slice(0, max).map((term) => term.term);
}

/** Levenshtein distance, stopping early once it cannot come in under `limit`. */
function distance(a: string, b: string, limit: number): number {
  const left = [...a];
  const right = [...b];
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      best = Math.min(best, current[j]!);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length]!;
}

/** The closest term to `key`, if one is close enough — and not merely the
 * same word inflected, which is a grammatical difference, not a mishearing. */
function closestTerm(key: string, vocabulary: LectureTerm[]): LectureTerm | null {
  const length = codePointLength(key);
  if (length < MIN_TERM_LENGTH - 1) return null;
  let best: { term: LectureTerm; distance: number } | null = null;
  for (const term of vocabulary) {
    if (term.key === key) return null; // already spelled as the course spells it
    const limit = Math.floor(codePointLength(term.key) * MAX_DISTANCE_RATIO);
    if (!limit) continue;
    const found = distance(key, term.key, limit);
    if (found > limit) continue;
    const inflection =
      found === 1 && (term.key.startsWith(key) || key.startsWith(term.key));
    if (inflection) continue;
    if (!best || found < best.distance) best = { term, distance: found };
  }
  return best?.term ?? null;
}

/** "Thyloïdes," → "Thylakoïdes,": the term's letters, the heard word's
 * capital and punctuation. */
function respell(heard: string, term: string): string {
  const match = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(heard);
  const [, before = '', core = heard, after = ''] = match ?? [];
  const capital = /^\p{Lu}/u.test(core) && /^\p{Ll}/u.test(term);
  const spelled = capital ? term[0]!.toUpperCase() + term.slice(1) : term;
  return `${before}${spelled}${after}`;
}

function doubtful(word: TranscriptWord): boolean {
  return word.confidence !== null && word.confidence < REVIEW_CONFIDENCE;
}

/**
 * Respell the doubtful words that are near misses of the lecture's
 * vocabulary. Returns new paragraphs and how many corrections were made; a
 * corrected word keeps its (low) confidence, so it stays highlighted.
 */
export function correctFromVocabulary(
  paragraphs: TranscriptParagraph[],
  vocabulary: LectureTerm[],
): { paragraphs: TranscriptParagraph[]; corrected: number } {
  if (!vocabulary.length) return { paragraphs, corrected: 0 };
  let corrected = 0;
  const result = paragraphs.map((paragraph) => {
    const words: TranscriptWord[] = [];
    for (let index = 0; index < paragraph.words.length; index += 1) {
      const word = paragraph.words[index]!;
      if (!doubtful(word)) {
        words.push(word);
        continue;
      }
      // Two doubtful words that are one term misheard as two.
      const next = paragraph.words[index + 1];
      if (next && doubtful(next)) {
        const pair = closestTerm(compactKey(`${word.text}${next.text}`), vocabulary);
        if (pair) {
          words.push({
            text: respell(`${word.text}${next.text}`, pair.term),
            start: word.start,
            end: next.end,
            confidence: Math.min(word.confidence!, next.confidence!),
          });
          corrected += 1;
          index += 1;
          continue;
        }
      }
      const single = closestTerm(compactKey(word.text), vocabulary);
      if (single) {
        words.push({ ...word, text: respell(word.text, single.term) });
        corrected += 1;
      } else {
        words.push(word);
      }
    }
    return { ...paragraph, words };
  });
  return { paragraphs: result, corrected };
}
