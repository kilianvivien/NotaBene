/**
 * Words, as the vocabulary sees them.
 *
 * Deliberately not `src/lib/search/fold.ts`. That fold matches the search
 * index, which throws accents away — right for finding "résumé" by typing
 * "resume", wrong here, where the accents are the thing a completion is for.
 * This module keeps the spelling and folds only to *compare*, one code point
 * at a time, so a folded prefix is always exactly as long as the text it came
 * from and the rest of a term can be cut off it by position.
 */

/**
 * A word: letters, digits and marks, optionally joined by hyphens
 * ("laissez-faire", "Jean-Jacques"). Apostrophes split, because in French they
 * elide an article onto the word — "l'enzyme" is the article and "enzyme", and
 * the vocabulary wants the second.
 */
const WORD = /[\p{L}\p{N}\p{M}]+(?:-[\p{L}\p{N}\p{M}]+)*/gu;

/** The word being typed at the end of `text`, allowing a trailing hyphen so
 * "laissez-" still completes to "laissez-faire". */
const WORD_AT_END = /[\p{L}\p{N}\p{M}]+(?:-[\p{L}\p{N}\p{M}]*)*$/u;

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;

export function isVocabularyWordCharacter(character: string): boolean {
  return WORD_CHARACTER.test(character);
}

/** NFC and single spaces: the form every term is stored and compared in. A
 * decomposed "é" pasted from a PDF must be the same word as a typed one. */
export function normalizeTerm(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** One code point, without its accent and in lower case — always exactly one
 * code point back, which is what keeps `foldKey` length-preserving. */
function foldCodePoint(character: string): string {
  const base = [...character.normalize('NFD')][0] ?? character;
  return [...base.toLowerCase()][0] ?? base;
}

/** The comparison key for a term: accent- and case-insensitive, and the same
 * number of code points as its (NFC) input. */
export function foldKey(value: string): string {
  let key = '';
  for (const character of value.normalize('NFC')) key += foldCodePoint(character);
  return key;
}

export function codePointLength(value: string): number {
  return [...value].length;
}

/** Every word in a passage, in order, spelled as written (NFC). */
export function wordsIn(text: string): string[] {
  return text.normalize('NFC').match(WORD) ?? [];
}

/** The partial word ending `text`, or `''` when it ends on anything else. */
export function wordAtEnd(text: string): string {
  return WORD_AT_END.exec(text)?.[0] ?? '';
}

/** True for a spelling with no upper case in it. */
export function isLowerCase(value: string): boolean {
  return value === value.toLocaleLowerCase();
}

/**
 * Carry the case the student is typing onto the completion.
 *
 * A term with capitals of its own — "Schrödinger", "ATP" — is a proper noun or
 * an acronym and keeps them. A lower-case term follows what was typed: a
 * capital at the start of a sentence stays a capital, and a word being typed
 * in capitals continues in capitals.
 */
export function adaptCase(term: string, typed: string): string {
  if (!isLowerCase(term)) return term;
  const letters = [...typed].filter((character) => /\p{L}/u.test(character));
  if (letters.length >= 2 && letters.every((c) => c !== c.toLocaleLowerCase())) {
    return term.toLocaleUpperCase();
  }
  const first = [...typed][0];
  if (first && first !== first.toLocaleLowerCase()) {
    const [head = '', ...tail] = [...term];
    return head.toLocaleUpperCase() + tail.join('');
  }
  return term;
}
