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
import type { AskMode, AskScope, AskTurn } from '@/lib/ai';

/**
 * One thread per grounding mode *and* scope.
 *
 * Mode already had to be separate: a strict thread must never receive an
 * earlier answer that was allowed to use outside knowledge. Scope needs the
 * same isolation for the same reason — an answer grounded in twelve notes is
 * not valid history for a question about one, and the `<note index>` positions
 * the model saw shift between turns anyway.
 */
export function threadKey(mode: AskMode, scope: AskScope): string {
  return `${mode}|${scope}`;
}

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
  askScope: AskScope;
  /** Keyed by note, then by `threadKey(mode, scope)`. */
  threads: Record<string, Record<string, AskThread>>;

  refreshProviders(): Promise<void>;
  setRunning(activity: AiActivity | null): void;
  setError(message: string | null): void;
  setAskMode(mode: AskMode): void;
  setAskScope(scope: AskScope): void;
  appendToken(noteId: string, key: string, token: string): void;
  commitTurn(noteId: string, key: string, turn: AskTurn): void;
  /** Drop a partial answer without turning it into a turn — a failure that
   * produced no text should leave no empty bubble behind. */
  discardStreaming(noteId: string, key: string): void;
  clearThread(noteId: string, key: string): void;
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
    askScope: 'note',
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

    setAskScope(scope) {
      set((state) => {
        state.askScope = scope;
      });
    },

    appendToken(noteId, key, token) {
      set((state) => {
        const noteThreads = (state.threads[noteId] ??= {});
        const thread = (noteThreads[key] ??= { turns: [], streaming: '' });
        thread.streaming += token;
      });
    },

    commitTurn(noteId, key, turn) {
      set((state) => {
        const noteThreads = (state.threads[noteId] ??= {});
        const thread = (noteThreads[key] ??= { turns: [], streaming: '' });
        thread.turns.push(turn);
        thread.streaming = '';
      });
    },

    discardStreaming(noteId, key) {
      set((state) => {
        const thread = state.threads[noteId]?.[key];
        if (thread) thread.streaming = '';
      });
    },

    clearThread(noteId, key) {
      set((state) => {
        const noteThreads = state.threads[noteId];
        if (!noteThreads) return;
        delete noteThreads[key];
        // Keyed by a composite now, so the old explicit two-mode check would
        // have kept an empty record alive forever.
        if (!Object.keys(noteThreads).length) delete state.threads[noteId];
      });
    },
  })),
);

export const EMPTY_THREAD: AskThread = { turns: [], streaming: '' };
