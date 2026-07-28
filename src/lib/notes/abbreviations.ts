/**
 * Typing shortcuts: the pure half.
 *
 * Kept out of the editor extension so both sides of the feature — the
 * ProseMirror plugin that expands as you type and the Settings pane that edits
 * the list — agree on what a valid abbreviation is and on when one matches,
 * and so the matching rules can be tested without a document.
 */
import { newId } from '@/lib/schema/defaults';
import type { Abbreviation } from '@/lib/adapters';

/** Long enough for "def:" style prefixes and a phrase, short enough that a
 * corrupt settings file cannot make every keystroke scan a novel. */
export const MAX_TRIGGER_LENGTH = 64;
export const MAX_EXPANSION_LENGTH = 500;
export const MAX_ABBREVIATIONS = 500;

/** Letters, digits and underscore, across scripts — `é` and `π` are as much
 * part of a word as `a` is, and a French user types both. */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

export function isWordCharacter(character: string): boolean {
  return WORD_CHARACTER.test(character);
}

/**
 * True when typing `text` ends a word, and so commits an expansion: it closes
 * on a space, a newline, `.`, `)`, `—` — anything that is not part of a word.
 * Takes a string rather than a character because ProseMirror reports several
 * at once when typing outruns it.
 */
export function endsWord(text: string): boolean {
  const last = [...text].at(-1);
  return last !== undefined && !isWordCharacter(last);
}

export function createAbbreviation(trigger = '', expansion = ''): Abbreviation {
  return { id: newId(), trigger, expansion };
}

/**
 * Accept a stored list from disk. Settings are ordinary JSON that a user may
 * hand-edit, so nothing here trusts its shape: anything that is not a usable
 * pair is dropped rather than allowed to reach the typing path.
 */
export function normalizeAbbreviations(value: unknown): Abbreviation[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: Abbreviation[] = [];

  for (const entry of value) {
    if (result.length >= MAX_ABBREVIATIONS) break;
    if (!entry || typeof entry !== 'object') continue;
    const { id, trigger, expansion } = entry as Partial<Abbreviation>;
    if (typeof trigger !== 'string' || typeof expansion !== 'string') continue;

    // A trigger with surrounding whitespace could never be typed to the end of
    // a word, so it would sit in the list looking broken.
    const cleanTrigger = trigger.trim();
    if (!cleanTrigger || !expansion) continue;
    if (cleanTrigger.length > MAX_TRIGGER_LENGTH) continue;
    if (expansion.length > MAX_EXPANSION_LENGTH) continue;

    const key = cleanTrigger.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: typeof id === 'string' && id ? id : newId(),
      trigger: cleanTrigger,
      expansion,
    });
  }

  return result;
}

export interface AbbreviationMatch {
  /** Offset in `textBefore` where the typed trigger starts. */
  start: number;
  /** What to put there, already case-adjusted to the typed trigger. */
  replacement: string;
  abbreviation: Abbreviation;
}

/**
 * Find the abbreviation the user has just finished typing.
 *
 * `textBefore` is the text of the current block up to the cursor. The longest
 * trigger wins, so `def` and `def:` can coexist without the shorter one
 * shadowing the longer.
 */
export function matchAbbreviation(
  textBefore: string,
  abbreviations: readonly Abbreviation[],
): AbbreviationMatch | null {
  let best: AbbreviationMatch | null = null;
  let bestLength = 0;

  for (const abbreviation of abbreviations) {
    const { trigger } = abbreviation;
    if (!trigger || trigger.length > textBefore.length) continue;
    if (trigger.length < bestLength) continue;

    const typed = textBefore.slice(textBefore.length - trigger.length);
    const exact = typed === trigger;
    // A lower-case trigger is a spelling, not a distinction: `nb` should fire
    // on `Nb` too. A trigger the user capitalised themselves is deliberate and
    // only ever matches as written.
    const insensitive =
      !exact &&
      trigger === trigger.toLowerCase() &&
      typed.toLowerCase() === trigger.toLowerCase();
    if (!exact && !insensitive) continue;

    const start = textBefore.length - trigger.length;
    // Mid-word text is not an abbreviation: `theorem` must not expand the `the`
    // hiding at its front. Only guard when the trigger itself starts a word —
    // a `;dt` style trigger is meant to be typed straight after a letter.
    if (
      start > 0 &&
      isWordCharacter(trigger[0] ?? '') &&
      isWordCharacter(textBefore[start - 1] ?? '')
    ) {
      continue;
    }

    best = {
      start,
      replacement: exact
        ? abbreviation.expansion
        : matchCase(typed, abbreviation.expansion),
      abbreviation,
    };
    bestLength = trigger.length;
  }

  return best;
}

/** Carry the capitalisation of what was typed onto the expansion, so a
 * sentence that opens with `Btw` does not expand into a lower-case one. */
function matchCase(typed: string, expansion: string): string {
  if (typed.length > 1 && typed === typed.toUpperCase() && /\p{L}/u.test(typed)) {
    return expansion.toUpperCase();
  }
  const first = typed[0] ?? '';
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return expansion.charAt(0).toUpperCase() + expansion.slice(1);
  }
  return expansion;
}
