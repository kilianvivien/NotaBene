import { create } from 'zustand';
import i18n from '@/lib/i18n';
import {
  startDictationCommand,
  stopDictationCommand,
  type ActiveDictationSession,
} from '@/lib/commands/dictationCommands';
import { fail, ok, type CommandResult } from '@/lib/commands/types';
import { registerDictationFinisher } from '@/lib/recording/dictationLifecycle';
import { useUiStore } from './uiStore';
import { useLibraryAccessStore } from './libraryAccessStore';

interface DictationState {
  status: 'idle' | 'starting' | 'listening' | 'stopping';
  noteId: string | null;
  startedAt: number | null;
  level: number;
  start(noteId: string): Promise<CommandResult<unknown>>;
  stop(): Promise<CommandResult<unknown>>;
}
const IDLE = { status: 'idle' as const, noteId: null, startedAt: null, level: 0 };
let controller: AbortController | null = null;
let session: ActiveDictationSession | null = null;
let starting: Promise<CommandResult<unknown>> | null = null;
let stopping: Promise<CommandResult<unknown>> | null = null;
let interrupted = false;

export const useDictationStore = create<DictationState>((set, get) => ({
  ...IDLE,
  async start(noteId) {
    if (get().status !== 'idle') return fail('conflict', i18n.t('dictation.busy'));
    interrupted = false;
    controller = new AbortController();
    const signal = controller.signal;
    set({ ...IDLE, status: 'starting', noteId });
    starting = (async () => {
      const result = await startDictationCommand({
        noteId,
        signal,
        onLevel: (level) => {
          if (get().status === 'listening') set({ level });
        },
        onFailure: () => {
          if (signal.aborted) return;
          interrupted = true;
          controller?.abort();
          if (get().status === 'listening') void get().stop();
        },
      });
      if (!result.ok) {
        set(IDLE);
        controller = null;
        if (result.code !== 'cancelled' || interrupted) {
          useUiStore
            .getState()
            .showStatusNotice(interrupted ? i18n.t('dictation.failed') : result.message);
        }
        return result;
      }
      session = result.value;
      if (!signal.aborted) set({ status: 'listening', startedAt: Date.now() });
      return ok(undefined);
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  },
  stop() {
    if (stopping) return stopping;
    if (get().status === 'idle') return Promise.resolve(ok(undefined));
    if (get().status === 'starting') controller?.abort();
    set({ status: 'stopping', level: 0 });
    stopping = (async () => {
      await starting;
      const result = session ? await stopDictationCommand(session) : ok(undefined);
      session = null;
      controller = null;
      set(IDLE);
      useUiStore
        .getState()
        .showStatusNotice(
          interrupted || !result.ok
            ? i18n.t('dictation.failed')
            : i18n.t('dictation.stopped'),
        );
      return result;
    })().finally(() => {
      stopping = null;
    });
    return stopping;
  },
}));
registerDictationFinisher(() => useDictationStore.getState().stop());
useLibraryAccessStore.subscribe((state) => {
  if (state.status?.readOnly && useDictationStore.getState().status !== 'idle') {
    void useDictationStore.getState().stop();
  }
});
