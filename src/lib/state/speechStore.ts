/**
 * Reading a note aloud.
 *
 * Separate from the podcast panel on purpose. The podcast is a produced thing —
 * a model writes a script, you read it, then you decide to have it spoken. This
 * is the other half of the same want: the note, as written, out loud, one click
 * from the toolbar. The selected engine owns the privacy boundary: macOS
 * system voices stay on-device; hosted Voxtral is an explicit Mistral request.
 *
 * Playback is a queue rather than one file. Synthesis of a long note takes
 * tens of seconds, so the first chunk starts playing while the rest are still
 * being made — `readAloudCommand` pushes each one here as it arrives and the
 * `ended` handler walks the queue. That is what makes the button feel like a
 * play button instead of a progress bar.
 *
 * One store, one voice: starting a second reading stops the first. Two notes
 * talking over each other is never what anyone meant.
 */
import { create } from 'zustand';
import { listPodcastVoicesCommand, readAloudCommand } from '@/lib/commands';
import type { SpokenSegment } from '@/lib/commands';
import { useSettingsStore } from './settingsStore';

export type SpeechStatus = 'idle' | 'preparing' | 'playing' | 'paused';
export type SpeechPhase = '' | 'generating';

interface SpeechState {
  status: SpeechStatus;
  /** A reader-facing explanation for the otherwise silent gap before the
   * first chunk. */
  phase: SpeechPhase;
  /** Chunks spoken so far, and how many there will be. Drives the progress
   * ring on the toolbar button. */
  done: number;
  total: number;
  error: string;
  speak(text: string, voiceId?: string): Promise<void>;
  toggle(): void;
  stop(): void;
}

/** Playback lives outside the store: an `HTMLAudioElement` and an object URL
 * are not state React should re-render over, and keeping them in module scope
 * is what lets `stop()` be synchronous. */
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let controller: AbortController | null = null;
let queue: SpokenSegment[] = [];
let cursor = 0;

function element(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.addEventListener('ended', playNext);
  }
  return audio;
}

function release(): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

/**
 * Advance the queue, or wait.
 *
 * "Wait" is the interesting case: playback can catch up with synthesis on a
 * fast machine, and the right answer then is to sit in `preparing` until the
 * next chunk lands rather than to stop — `push` calls back in here.
 */
function playNext(): void {
  const next = queue[cursor];
  if (!next) {
    const state = useSpeechStore.getState();
    // Nothing left and nothing coming: the reading is over.
    if (state.total > 0 && state.done >= state.total) useSpeechStore.getState().stop();
    else if (state.status === 'playing') useSpeechStore.setState({ status: 'preparing' });
    return;
  }

  cursor += 1;
  release();
  objectUrl = URL.createObjectURL(next.audio);
  const player = element();
  player.src = objectUrl;
  useSpeechStore.setState({ status: 'playing' });
  void player.play().catch(() => useSpeechStore.getState().stop());
}

export const useSpeechStore = create<SpeechState>((set, get) => ({
  status: 'idle',
  phase: '',
  done: 0,
  total: 0,
  error: '',

  async speak(text: string, requestedVoiceId?: string) {
    get().stop();

    const settings = useSettingsStore.getState().settings;
    const speech = settings.speech;
    let voiceId = requestedVoiceId ?? speech.voicesByEngine[speech.engineId];

    // Resolve a default the first time so pressing play never fails for a
    // reason that reads as "nothing happened".
    if (!voiceId) {
      let voices = await listPodcastVoicesCommand(settings.locale, speech.engineId);
      if (!voices.ok && speech.engineId !== 'system' && speech.fallbackToSystem) {
        voices = await listPodcastVoicesCommand(settings.locale, 'system');
      }
      if (!voices.ok || !voices.value.length) {
        set({ status: 'idle', error: voices.ok ? 'no voices' : voices.message });
        return;
      }
      voiceId = voices.value[0]!.id;
      void useSettingsStore.getState().update({
        speech: {
          ...speech,
          voicesByEngine: {
            ...speech.voicesByEngine,
            [speech.engineId]: voiceId,
          },
        },
      });
    }

    controller = new AbortController();
    const signal = controller.signal;
    queue = [];
    cursor = 0;
    set({
      status: 'preparing',
      phase: 'generating',
      done: 0,
      total: 0,
      error: '',
    });

    const outcome = await readAloudCommand(text, {
      voiceId,
      engineId: speech.engineId,
      rate: speech.playbackRate,
      fallbackToSystem: speech.fallbackToSystem,
      locale: settings.locale,
      signal,
      onSynthesisStart: () => set({ phase: 'generating' }),
      onChunk: (chunk, index, total) => {
        if (signal.aborted) return;
        queue.push(chunk);
        set({ done: index + 1, total, phase: '' });
        // Start the moment the first chunk exists, and only then.
        if (get().status === 'preparing') playNext();
      },
    });

    if (signal.aborted) return;
    if (!outcome.ok) {
      get().stop();
      set({ status: 'idle', phase: '', error: outcome.message });
    }
    // Synthesis finishing does not end playback — the queue is still draining.
  },

  toggle() {
    const player = audio;
    if (!player) return;
    if (get().status === 'playing') {
      player.pause();
      set({ status: 'paused' });
    } else if (get().status === 'paused') {
      void player.play();
      set({ status: 'playing' });
    }
  },

  stop() {
    controller?.abort();
    controller = null;
    audio?.pause();
    if (audio) audio.src = '';
    release();
    queue = [];
    cursor = 0;
    set({ status: 'idle', phase: '', done: 0, total: 0 });
  },
}));
