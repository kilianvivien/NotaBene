/**
 * Ask a question about a note, a course, or the whole library.
 *
 * The one AI feature here that writes nothing at all: it reads notes, holds a
 * short conversation about them, and stops. That is what lets it stream
 * straight into the panel with no diff gate — there is nothing to gate.
 *
 * At `scope: 'note'` it is grounded by construction. The whole note goes into
 * the system message, so there is no retrieval step to get wrong on a corpus
 * that size; a lecture note is a few thousand tokens and chunking it would only
 * introduce a way to miss the paragraph the student was asking about. That path
 * is unchanged, and must stay unchanged.
 *
 * The wider scopes cannot have that guarantee — a course does not fit in a
 * prompt — so they trade it for a weaker, honest one: the notes here were
 * chosen by a search that can miss, the answer says so, and the panel shows
 * which notes it read. Sources arrive already chosen and packed
 * (`src/lib/commands/retrievalCommands.ts`); this file only asks the question.
 */
import { docToMarkdown } from '@/editor/markdown';
import type { Note } from '@/lib/schema';
import { runAi, type AiRunOptions } from './client';
import { askPrompt, type AskMode } from './prompts';
import type { AskScope } from './retrieval';
import type { AiMessage, ResolvedProvider } from './protocols';

/** One exchange. Kept in the store, never persisted: a question you asked
 * about a note is not part of the note, and a backup should not carry it. */
export interface AskTurn {
  role: 'user' | 'assistant';
  content: string;
  /** The notes this answer was given, on assistant turns at a wider scope.
   * Taken from what was sent, never parsed out of the answer. */
  sources?: { noteId: string; title: string; truncated: boolean }[];
  /** Relevant notes that did not fit the budget. */
  droppedCount?: number;
}

export interface AskRequest {
  provider: ResolvedProvider;
  mode: AskMode;
  /** How wide the search that produced `sources` was allowed to go. */
  scope: AskScope;
  sources: (Pick<Note, 'title' | 'doc'> & { truncated?: boolean })[];
  history: AskTurn[];
  question: string;
  language: string;
}

export async function requestAnswer(
  request: AskRequest,
  options: AiRunOptions = {},
): Promise<string> {
  const question = request.question.trim();
  if (!question) throw new Error('ask a question first');
  if (!request.sources.length) throw new Error('open a note to ask about it');

  return runAi(
    {
      provider: request.provider,
      messages: askPrompt({
        mode: request.mode,
        scope: request.scope,
        sources: request.sources.map((note) => ({
          title: note.title,
          markdown: docToMarkdown(note.doc),
          truncated: note.truncated,
        })),
        // Only the last few turns travel. A side-panel conversation that
        // silently grew its own bill with every question would be the exact
        // cost surprise the plan warns about.
        history: trimHistory(request.history),
        question,
        language: request.language,
      }),
      maxTokens: 2_000,
      temperature: 0.2,
      json: false,
      stream: true,
    },
    options,
  );
}

const MAX_HISTORY_TURNS = 8;

function trimHistory(history: AskTurn[]): AiMessage[] {
  return history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
}
