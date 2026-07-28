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
import type { AskMode, AskTurn } from '@/lib/ai';

/** In-flight work, so the cancel button has something to cancel and two
 * features cannot fight over the same panel. `speech` is the odd one out: it is
 * the only activity that is not a provider call, and it is separate from
 * `podcast` because a student can cancel the synthesiser without throwing away
 * the script it was reading. */
export type AiActivity =
  'rewrite' | 'synthesis' | 'ask' | 'mindMap' | 'flashcards' | 'podcast' | 'speech';

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
  askMode: AskMode;
  /** Ask conversations are isolated by note and grounding mode. Strict mode
   * must never receive an earlier answer that was allowed to use outside
   * knowledge as conversation context. */
  threads: Record<string, Partial<Record<AskMode, AskThread>>>;

  refreshProviders(): Promise<void>;
  setRunning(activity: AiActivity | null): void;
  setError(message: string | null): void;
  setAskMode(mode: AskMode): void;
  appendToken(noteId: string, mode: AskMode, token: string): void;
  commitTurn(noteId: string, mode: AskMode, turn: AskTurn): void;
  /** Drop a partial answer without turning it into a turn — a failure that
   * produced no text should leave no empty bubble behind. */
  discardStreaming(noteId: string, mode: AskMode): void;
  clearThread(noteId: string, mode: AskMode): void;
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
    askMode: 'knowledge',
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

    setAskMode(mode) {
      set((state) => {
        state.askMode = mode;
      });
    },

    appendToken(noteId, mode, token) {
      set((state) => {
        const noteThreads = (state.threads[noteId] ??= {});
        const thread = (noteThreads[mode] ??= { turns: [], streaming: '' });
        thread.streaming += token;
      });
    },

    commitTurn(noteId, mode, turn) {
      set((state) => {
        const noteThreads = (state.threads[noteId] ??= {});
        const thread = (noteThreads[mode] ??= { turns: [], streaming: '' });
        thread.turns.push(turn);
        thread.streaming = '';
      });
    },

    discardStreaming(noteId, mode) {
      set((state) => {
        const thread = state.threads[noteId]?.[mode];
        if (thread) thread.streaming = '';
      });
    },

    clearThread(noteId, mode) {
      set((state) => {
        const noteThreads = state.threads[noteId];
        if (!noteThreads) return;
        delete noteThreads[mode];
        if (!noteThreads.note && !noteThreads.knowledge) delete state.threads[noteId];
      });
    },
  })),
);

export const EMPTY_THREAD: AskThread = { turns: [], streaming: '' };
