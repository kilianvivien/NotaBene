/**
 * The lecture recording in progress, if any (plan §10.0).
 *
 * One at a time, for one note. Switching notes keeps it running — the lecture
 * does not stop because the student glanced at last week's notes — but only the
 * note it started in receives anchors, and the chrome names that note so the
 * difference is never a surprise.
 *
 * The session handle lives in module scope, like the speech store's audio
 * element: it is not state React should re-render over.
 */
import { create } from 'zustand';
import i18n from '@/lib/i18n';
import {
  cancelRecordingCommand,
  fail,
  keepRecordingCommand,
  ok,
  startRecordingCommand,
  type CommandResult,
  type RecorderSession,
} from '@/lib/commands';
import { useUiStore } from './uiStore';

export type RecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping';

/** What an anchor needs to know. `null` whenever nothing is being recorded. */
export interface ActiveRecording {
  recordingId: string;
  noteId: string;
  startedAt: number;
}

interface RecordingState {
  status: RecordingStatus;
  recordingId: string | null;
  noteId: string | null;
  /** Captured at the start so the status bar can name the note from any view. */
  noteTitle: string;
  startedAt: number | null;
  /** 0–1, for the meter. */
  level: number;
  start(noteId: string, noteTitle: string): Promise<CommandResult<unknown>>;
  /** Stop and keep the recording as an attachment on its note. */
  stop(): Promise<CommandResult<unknown>>;
  /** Stop and throw it away. */
  cancel(): Promise<CommandResult<unknown>>;
}

let session: RecorderSession | null = null;

const IDLE = {
  status: 'idle' as const,
  recordingId: null,
  noteId: null,
  noteTitle: '',
  startedAt: null,
  level: 0,
};

function notice(message: string): void {
  useUiStore.getState().showStatusNotice(message);
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  ...IDLE,

  async start(noteId, noteTitle) {
    if (get().status !== 'idle')
      return fail('conflict', i18n.t('recording.alreadyRunning'));
    set({ ...IDLE, status: 'starting', noteId, noteTitle });
    const started = await startRecordingCommand({
      noteId,
      onLevel: (level) => {
        if (get().status === 'recording') set({ level });
      },
      // The microphone or the disk went away mid-lecture. Keep what was
      // written — it is on disk up to the last slice — and say so.
      onFailure: () => {
        if (get().status !== 'recording') return;
        notice(i18n.t('recording.interrupted'));
        void get().stop();
      },
    });
    if (!started.ok) {
      set(IDLE);
      notice(started.message);
      return started;
    }
    session = started.value;
    set({
      status: 'recording',
      recordingId: started.value.id,
      startedAt: started.value.startedAt,
    });
    return ok(undefined);
  },

  async stop() {
    const current = session;
    const noteId = get().noteId;
    if (!current || !noteId || get().status !== 'recording') {
      return fail('not_found', i18n.t('recording.notRunning'));
    }
    set({ status: 'stopping', level: 0 });
    const kept = await keepRecordingCommand(current, noteId);
    session = null;
    set(IDLE);
    notice(kept.ok ? i18n.t('recording.saved') : kept.message);
    return kept;
  },

  async cancel() {
    const current = session;
    if (!current || get().status !== 'recording') {
      return fail('not_found', i18n.t('recording.notRunning'));
    }
    set({ status: 'stopping', level: 0 });
    const cancelled = await cancelRecordingCommand(current);
    session = null;
    set(IDLE);
    return cancelled;
  },
}));

export function activeRecording(): ActiveRecording | null {
  const state = useRecordingStore.getState();
  return state.status === 'recording' &&
    state.recordingId &&
    state.noteId &&
    state.startedAt
    ? { recordingId: state.recordingId, noteId: state.noteId, startedAt: state.startedAt }
    : null;
}
