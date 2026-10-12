/**
 * What counts as one note mentioning another.
 *
 * The TypeScript half of the rules in `src-tauri/src/db/graph.rs`: whole
 * title, whole words, case-insensitive, and no title under four characters.
 * Two callers share it — the in-memory adapter, to find mentions at all, and
 * the command that turns one into a link, to find where in the document it
 * is. The second is why this returns a position in the *original* string: a
 * lowercased copy can be a different length, and an offset from one would cut
 * the other in the wrong place.
 */

/** Titles shorter than this are never offered — "Lab" would match everywhere. */
export const MIN_MENTION_TITLE_CHARS = 4;

const WORD_CHAR = /[\p{L}\p{N}_]/u;

export interface MentionMatch {
  start: number;
  end: number;
}

/** The key duplicate titles collide on; the first note to hold one keeps it. */
export function mentionKey(title: string): string {
  return title.trim().toLowerCase();
}

export function isMentionableTitle(title: string): boolean {
  return [...title.trim()].length >= MIN_MENTION_TITLE_CHARS;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A matcher for one title, built once and run over many texts.
 *
 * The word boundaries are checked by hand rather than with a lookbehind:
 * `(?<!…)` only reached WebKit in Safari 16.4, and the app still runs on the
 * macOS 13 releases that shipped before it.
 */
export function mentionMatcher(title: string): (text: string) => MentionMatch | null {
  const wanted = title.trim();
  if (!isMentionableTitle(wanted)) return () => null;
  const pattern = new RegExp(escapeRegExp(wanted), 'giu');
  return (text) => {
    pattern.lastIndex = 0;
    for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
      const start = found.index;
      const end = start + found[0].length;
      // Two code units back is enough to hold one whole character.
      const before = [...text.slice(Math.max(0, start - 2), start)].pop();
      const after = [...text.slice(end, end + 2)][0];
      if (!(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))) {
        return { start, end };
      }
      // Step one character, not one match, so an overlapping candidate —
      // "anna" in "annanna" — is still tried.
      pattern.lastIndex = start + 1;
    }
    return null;
  };
}

/** The first whole-word occurrence of `title` in `text`, or null. */
export function findMention(text: string, title: string): MentionMatch | null {
  return mentionMatcher(title)(text);
}

/** Short, so the mention itself is inside the two lines the inspector shows.
 * Kept equal to `SNIPPET_LEAD_CHARS` in `db/graph.rs`. */
const SNIPPET_LEAD = 24;
const SNIPPET_LENGTH = 200;

/** The text around a mention, for the list that offers to link it. */
export function mentionSnippet(text: string, match: MentionMatch): string {
  const from = Math.max(0, match.start - SNIPPET_LEAD);
  const cut = text
    .slice(from, from + SNIPPET_LENGTH)
    .replace(/\s/g, ' ')
    .trim();
  return from > 0 ? `… ${cut}` : cut;
}
