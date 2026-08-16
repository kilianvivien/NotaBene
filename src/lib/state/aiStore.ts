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
import {
  AI_PROVIDERS,
  baseUrlFor,
  configuredProviderIds,
  detectLocalModels,
  supportsModelDetection,
} from '@/lib/ai';
import type { AskMode, AskScope, AskTurn, DetectedModels } from '@/lib/ai';
import type { AppSettings } from '@/lib/adapters';

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
  | 'rewrite'
  | 'synthesis'
  | 'ask'
  | 'mindMap'
  | 'flashcards'
  | 'podcast'
  | 'importFormat'
  | 'agent'
  | 'taskPlan'
  | 'taskCheck'
  | 'speech';

export interface AskThread {
  turns: AskTurn[];
  /** Tokens arriving right now, before the turn is committed. */
  streaming: string;
}

interface AiState {
  /** Provider ids with a key on file. Names only — never a value. */
  configuredProviderIds: string[];
  /** What each local runtime reported it was running, last time we asked. */
  localModels: DetectedModels;
  running: AiActivity | null;
  error: string | null;
  askMode: AskMode;
  askScope: AskScope;
  /** Which half of the inspector's AI tab is showing: the conversation, or the
   * agent. Not a third `AskMode`, because it is orthogonal to grounding — an
   * agent run has no thread and no notes-versus-knowledge choice. */
  agentMode: boolean;
  /** Keyed by note, then by `threadKey(mode, scope)`. */
  threads: Record<string, Record<string, AskThread>>;

  refreshProviders(): Promise<void>;
  /** Ask every enabled local runtime what it has loaded. Cheap, silent, and
   * throttled — see `PROBE_INTERVAL_MS`. */
  refreshLocalModels(settings: AppSettings, force?: boolean): Promise<void>;
  setRunning(activity: AiActivity | null): void;
  setError(message: string | null): void;
  setAskMode(mode: AskMode): void;
  setAskScope(scope: AskScope): void;
  setAgentMode(on: boolean): void;
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

/**
 * How stale a detection may get before the next mount re-runs it.
 *
 * Every status pill refreshes providers on mount, and there are several on
 * screen at once; without a floor, opening the AI panel would fire a burst of
 * probes at localhost. Twenty seconds is short enough that loading a different
 * model in LM Studio shows up while the student is still looking at the app,
 * and long enough that the burst becomes one request.
 */
const PROBE_INTERVAL_MS = 20_000;

/** Outside the store for the same reason as the controllers: it is bookkeeping
 * about a request, not state anything renders. */
let lastProbeAt = 0;
let probeInFlight: Promise<void> | null = null;

export function beginRun(activity: AiActivity): AbortSignal {
  cancelRun(activity);
  const controller = new AbortController();
  controllers.set(activity, controller);
  useAiStore.getState().setRunning(activity);
  useAiStore.getState().setError(null);
  return controller.signal;
}

/**
 * A run has finished. Pass the signal `beginRun` returned: a cancelled run
 * unwinds *after* the student has started another one, and without something
 * to identify itself by it would clear the spinner belonging to that second
 * run.
 */
export function endRun(activity: AiActivity, signal?: AbortSignal): void {
  const current = controllers.get(activity);
  if (signal && current && current.signal !== signal) return;
  controllers.delete(activity);
  if (useAiStore.getState().running === activity) {
    useAiStore.getState().setRunning(null);
  }
}

/** Stop a run. The spinner goes out here rather than when the call finally
 * unwinds — the whole point of the button is that the wait is over. */
export function cancelRun(activity: AiActivity): void {
  controllers.get(activity)?.abort(new DOMException('cancelled', 'AbortError'));
  controllers.delete(activity);
  if (useAiStore.getState().running === activity) {
    useAiStore.getState().setRunning(null);
  }
}

export const useAiStore = create<AiState>()(
  immer((set) => ({
    configuredProviderIds: [],
    localModels: {},
    running: null,
    error: null,
    askMode: 'knowledge',
    askScope: 'note',
    agentMode: false,
    threads: {},

    async refreshProviders() {
      const ids = await configuredProviderIds();
      set((state) => {
        state.configuredProviderIds = ids;
      });
    },

    async refreshLocalModels(settings, force = false) {
      // A forced probe queues behind an in-flight one rather than joining it:
      // the reason to force is that the settings just changed, and the running
      // probe was started against the old ones. Joining it would answer the
      // previous question.
      if (probeInFlight) {
        if (!force) return probeInFlight;
        await probeInFlight.catch(() => {});
      } else if (!force && Date.now() - lastProbeAt < PROBE_INTERVAL_MS) {
        return;
      }

      // A runtime nobody switched on is a runtime we have no business
      // knocking on: the checkbox is the user's "yes, I run this".
      const targets = AI_PROVIDERS.filter(
        (definition) =>
          supportsModelDetection(definition) &&
          settings.aiProviders[definition.id]?.enabled === true,
      );

      probeInFlight = (async () => {
        const found = await Promise.all(
          targets.map(async (definition) => {
            const models = await detectLocalModels(
              definition,
              baseUrlFor(definition, settings),
            );
            return [definition.id, models] as const;
          }),
        );
        lastProbeAt = Date.now();
        set((state) => {
          // Replaced wholesale rather than merged: a runtime that has been shut
          // down since the last probe must stop claiming a loaded model.
          state.localModels = Object.fromEntries(found);
        });
      })().finally(() => {
        probeInFlight = null;
      });

      return probeInFlight;
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

    // Deliberately does not touch `running`: a run outlives the panel that
    // started it, so leaving agent mode — like closing the inspector or opening
    // another note — watches the run go on rather than killing it. Only the
    // Stop button cancels.
    setAgentMode(on) {
      set((state) => {
        state.agentMode = on;
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
