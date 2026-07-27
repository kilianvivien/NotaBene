/**
 * AI session state: which providers have keys, what is running, and the Ask
 * conversation for the open note.
 *
 * None of it is persisted. Key *names* are re-read from the Keychain at launch,
 * a run does not survive a reload, and a conversation about a note is not part
 * of the note — a backup that carried your questions would be a backup that
 * carried something you never asked it to keep.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { configuredProviderIds } from '@/lib/ai';
import type { AskTurn } from '@/lib/ai';

/** In-flight work, so the cancel button has something to cancel and two
 * features cannot fight over the same panel. `speech` is the odd one out: it is
 * the only activity that is not a provider call, and it is separate from
 * `podcast` because a student can cancel the synthesiser without throwing away
 * the script it was reading. */
export type AiActivity =
  | 'rewrite'
  | 'synthesis'
  | 'ask'
  | 'mindMap'
  | 'flashcards'
  | 'podcast'
  | 'speech';

export interface AskThread {
  turns: AskTurn[];
  /** Tokens arriving right now, before the turn is committed. */
  streaming: string;
}

interface AiState {
  /** Provider ids with a key on file. Names only — never a value. */
  configuredProviderIds: string[];
  running: AiActivity | null;
  error: string | null;
  /** Ask conversations, keyed by note id, so switching notes and coming back
   * does not lose the thread. */
  threads: Record<string, AskThread>;

  refreshProviders(): Promise<void>;
  setRunning(activity: AiActivity | null): void;
  setError(message: string | null): void;
  appendToken(noteId: string, token: string): void;
  commitTurn(noteId: string, turn: AskTurn): void;
  /** Drop a partial answer without turning it into a turn — a failure that
   * produced no text should leave no empty bubble behind. */
  discardStreaming(noteId: string): void;
  clearThread(noteId: string): void;
}

/** One controller per activity. Kept out of the store because an AbortController
 * is neither serialisable nor comparable, and immer would freeze it. */
const controllers = new Map<AiActivity, AbortController>();

export function beginRun(activity: AiActivity): AbortSignal {
  cancelRun(activity);
  const controller = new AbortController();
  controllers.set(activity, controller);
  useAiStore.getState().setRunning(activity);
  useAiStore.getState().setError(null);
  return controller.signal;
}

export function endRun(activity: AiActivity): void {
  controllers.delete(activity);
  if (useAiStore.getState().running === activity) {
    useAiStore.getState().setRunning(null);
  }
}

export function cancelRun(activity: AiActivity): void {
  controllers.get(activity)?.abort(new DOMException('cancelled', 'AbortError'));
  controllers.delete(activity);
}

export const useAiStore = create<AiState>()(
  immer((set) => ({
    configuredProviderIds: [],
    running: null,
    error: null,
    threads: {},

    async refreshProviders() {
      const ids = await configuredProviderIds();
      set((state) => {
        state.configuredProviderIds = ids;
      });
    },

    setRunning(activity) {
      set((state) => {
        state.running = activity;
      });
    },

    setError(message) {
      set((state) => {
        state.error = message;
      });
    },

    appendToken(noteId, token) {
      set((state) => {
        const thread = (state.threads[noteId] ??= { turns: [], streaming: '' });
        thread.streaming += token;
      });
    },

    commitTurn(noteId, turn) {
      set((state) => {
        const thread = (state.threads[noteId] ??= { turns: [], streaming: '' });
        thread.turns.push(turn);
        thread.streaming = '';
      });
    },

    discardStreaming(noteId) {
      set((state) => {
        const thread = state.threads[noteId];
        if (thread) thread.streaming = '';
      });
    },

    clearThread(noteId) {
      set((state) => {
        delete state.threads[noteId];
      });
    },
  })),
);

export const EMPTY_THREAD: AskThread = { turns: [], streaming: '' };
