/**
 * Anki export.
 *
 * Anki's own package format is a zipped SQLite database with a schema that
 * changes between releases. Writing one from the webview would mean bundling a
 * SQLite build and then chasing Anki's collection schema for the rest of the
 * app's life — for a file the student imports once. Anki 2.1.55 and later read
 * a delimited text file with `#` header lines that carry the deck, the note
 * type and the column mapping, which is a documented, stable, and dependency-
 * free import path that produces exactly the same notes.
 *
 * Tab-separated rather than comma-separated because a flashcard back is prose:
 * it contains commas constantly and tabs essentially never.
 */
import type { FlashcardDeck } from '@/lib/schema';

/**
 * Anki's text importer treats a field as HTML when `#html:true` is set, which
 * is what makes a multi-line back render as multiple lines. That also means a
 * literal `<` in a card about generics would be swallowed as a tag, so the
 * fields are escaped and the line breaks put back as `<br>`.
 */
function field(value: string): string {
  return (
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll(/\r?\n/g, '<br>')
      // A tab inside a field would end it early and shift every column after it.
      .replaceAll('\t', ' ')
      .trim()
  );
}

/** Anki tags are whitespace-delimited, so a tag cannot contain a space. */
function tag(value: string): string {
  return value.trim().replaceAll(/\s+/g, '-');
}

/**
 * Deck names are a path: `Analysis I::Lecture 3` nests. A title containing `::`
 * would create nesting the student did not ask for, and a newline would end the
 * header line.
 */
function deckName(title: string): string {
  return (
    title
      .replaceAll('::', ':')
      .replaceAll(/[\r\n\t]+/g, ' ')
      .trim() || 'NotaBene'
  );
}

export interface AnkiExportOptions {
  /** Prefixed to the deck path, so a course's decks group together in Anki's
   * sidebar the way they do in the sidebar here. */
  deckPrefix?: string;
  /** Added to every card on top of its own. `notabene` by default, which is
   * what makes a re-import easy to find and undo. */
  extraTags?: string[];
}

/**
 * One file, two note types.
 *
 * Anki's text format allows a `#notetype:` line to appear more than once, each
 * governing the rows that follow it, so a mixed deck exports as one file rather
 * than as two the student has to import separately. Basic and Cloze are both
 * built into every Anki installation, so neither needs to be created first.
 */
export function deckToAnkiTsv(
  deck: FlashcardDeck,
  options: AnkiExportOptions = {},
): string {
  const tags = [...(options.extraTags ?? ['notabene'])].map(tag).filter(Boolean);
  const name = options.deckPrefix
    ? `${deckName(options.deckPrefix)}::${deckName(deck.title)}`
    : deckName(deck.title);

  const lines = [
    '#separator:tab',
    '#html:true',
    `#deck:${name}`,
    '#columns:Front\tBack\tTags',
    '#tags column:3',
  ];

  // Grouped rather than interleaved: every `#notetype:` line switches the type
  // for everything after it, so alternating kinds would mean a header line
  // between almost every row.
  let current: string | null = null;
  for (const kind of ['basic', 'cloze'] as const) {
    for (const card of deck.cards.filter((entry) => entry.kind === kind)) {
      if (current !== kind) {
        lines.push(`#notetype:${kind === 'cloze' ? 'Cloze' : 'Basic'}`);
        current = kind;
      }
      // The hint rides on the front rather than needing a third field: "Basic
      // (and reversed)" and friends have different field counts, and a deck
      // that imports cleanly everywhere beats one with a dedicated hint field.
      const front = card.hint
        ? `${field(card.front)}<br><i>${field(card.hint)}</i>`
        : field(card.front);
      lines.push(
        [
          front,
          field(card.back),
          [...tags, ...card.tags.map(tag)].filter(Boolean).join(' '),
        ].join('\t'),
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function ankiFileName(deck: FlashcardDeck): string {
  const base = deck.title
    .normalize('NFKD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replaceAll(/^-|-$/g, '')
    .toLocaleLowerCase();
  return `${base || 'flashcards'}-anki.txt`;
}
