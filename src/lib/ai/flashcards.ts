/**
 * Flashcards: notes in, a deck out.
 *
 * The deck is not a library entity. It is generated, reviewed, and then either
 * written into the note as a self-test section or handed to Anki — which is
 * where a student's cards already live, and which does spaced repetition far
 * better than a note app ever should. Keeping decks out of `LibrarySchema` is
 * the reason this phase needed no schema version bump.
 */
import { docToMarkdown } from '@/editor/markdown';
import {
  AiFlashcardsResponseSchema,
  newId,
  type Flashcard,
  type FlashcardDeck,
  type Note,
} from '@/lib/schema';
import { runAi, type AiRunOptions } from './client';
import { parseModelJson } from './json';
import { flashcardsPrompt, type FlashcardStyle } from './prompts';
import type { ResolvedProvider } from './protocols';

export type { FlashcardStyle };

export interface FlashcardRequest {
  provider: ResolvedProvider;
  sources: Pick<Note, 'title' | 'doc'>[];
  style: FlashcardStyle;
  /** How many cards to aim for. The model is told this is a target, not a
   * quota — padding a thin lecture out to twenty cards produces twenty bad
   * ones. */
  count: number;
  language: string;
}

const CLOZE = /\{\{c\d+::[^}]*\}\}/;

/**
 * Reconcile the declared kind with the card itself.
 *
 * Anki decides how to schedule a card from its note type, and a cloze note
 * whose front carries no deletion imports as a card with nothing to hide —
 * Anki rejects it outright. A model that labelled a plain Q&A card "cloze" is
 * making a claim about text we can simply check.
 */
function kindOf(card: { kind: 'basic' | 'cloze'; front: string }): 'basic' | 'cloze' {
  return CLOZE.test(card.front) ? 'cloze' : card.kind === 'cloze' ? 'basic' : card.kind;
}

export async function requestFlashcards(
  request: FlashcardRequest,
  options: AiRunOptions = {},
): Promise<FlashcardDeck> {
  if (!request.sources.length) throw new Error('select at least one note');

  const text = await runAi(
    {
      provider: request.provider,
      messages: flashcardsPrompt({
        style: request.style,
        count: request.count,
        sources: request.sources.map((note) => ({
          title: note.title,
          markdown: docToMarkdown(note.doc),
        })),
        language: request.language,
      }),
      maxTokens: 8_000,
      temperature: 0.3,
      json: true,
      stream: false,
    },
    options,
  );

  const response = parseModelJson(AiFlashcardsResponseSchema, text);
  const cards: Flashcard[] = response.cards.map((card) => ({
    ...card,
    id: newId(),
    kind: kindOf(card),
  }));

  return { title: response.title.trim(), cards };
}
