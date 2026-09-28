/**
 * The transcription running now, if any (plan §10.3).
 *
 * A lecture takes minutes to transcribe, so the job outlives its dialog: the
 * student can close it and keep working, and the status bar carries the
 * progress from every view, as it does for a recording. One job at a time —
 * the helper and the student's key are both better spent on one lecture.
 *
 * The controller lives in module scope, like the recording session: not
 * state React should re-render over.
 */
import { create } from 'zustand';
import i18n from '@/lib/i18n';
import { notifications } from '@/lib/adapters';
import {
  transcribeAttachmentCommand,
  type TranscribeInput,
  type TranscriptionOutcome,
  type TranscriptionStage,
} from '@/lib/commands';

export type TranscriptionStatus = 'idle' | 'running' | 'done' | 'failed';

export interface TranscriptionFailure {
  code: string | null;
  message: string;
  /** Where in the lecture a window failed. */
  window?: { startMs: number; endMs: number };
  language?: string;
}

interface TranscriptionState {
  status: TranscriptionStatus;
  input: TranscribeInput | null;
  /** The lecture note's title, for the status bar in any view. */
  noteTitle: string;
  stage: TranscriptionStage;
  done: number;
  total: number;
  outcome: TranscriptionOutcome | null;
  failure: TranscriptionFailure | null;
  start(input: TranscribeInput, noteTitle: string): Promise<void>;
  cancel(): void;
  /** Forget a finished or failed job. */
  dismiss(): void;
}

let controller: AbortController | null = null;

const IDLE = {
  status: 'idle' as const,
  input: null,
  noteTitle: '',
  stage: 'preparing' as const,
  done: 0,
  total: 0,
  outcome: null,
  failure: null,
};

export const useTranscriptionStore = create<TranscriptionState>((set, get) => ({
  ...IDLE,

  async start(input, noteTitle) {
    if (get().status === 'running') return;
    controller = new AbortController();
    const signal = controller.signal;
    set({ ...IDLE, status: 'running', input, noteTitle });
    const result = await transcribeAttachmentCommand(input, {
      signal,
      onProgress: ({ stage, done, total }) => {
        if (!signal.aborted) set({ stage, done, total });
      },
    });
    if (controller?.signal === signal) controller = null;

    if (result.ok) {
      set({ status: 'done', outcome: result.value });
      // Only when the student is elsewhere: in front of the app, the dialog
      // or the status bar already says so.
      if (typeof document !== 'undefined' && document.hidden) {
        void notifications.notify({
          title: i18n.t('transcription.notifyTitle'),
          body: i18n.t('transcription.notifyBody', { title: noteTitle }),
        });
      }
      return;
    }
    if (result.code === 'cancelled') {
      set({ ...IDLE });
      return;
    }
    const details = (result.details ?? {}) as Partial<TranscriptionFailure> & {
      asrCode?: string | null;
    };
    set({
      status: 'failed',
      failure: {
        code: details.asrCode ?? null,
        message: result.message,
        window: details.window,
        language: details.language,
      },
    });
  },

  cancel() {
    controller?.abort();
    controller = null;
    set({ ...IDLE });
  },

  dismiss() {
    if (get().status === 'running') return;
    set({ ...IDLE });
  },
}));
