/**
 * Capture through `getUserMedia` + `MediaRecorder`, writing through a sink.
 *
 * The sink is where the bytes go; this file is only the microphone and the
 * encoder. Splitting them is what lets the plan's platform decision (§10.0
 * item 1) change one of the two without the other, and what lets a test drive
 * the capture with a fake recorder and an in-memory sink.
 */
import type { Asset } from '@/lib/schema';
import {
  RecorderUnavailableError,
  type InterruptedRecording,
  type RecorderAdapter,
  type RecorderSession,
  type RecorderStartRequest,
  type RecordingInput,
} from './RecorderAdapter';

export interface RecordingSink {
  begin(id: string, noteId: string, mime: string): Promise<void>;
  append(id: string, slice: Blob): Promise<void>;
  finish(id: string): Promise<Asset>;
  discard(id: string): Promise<void>;
  interrupted(): Promise<InterruptedRecording[]>;
}

/** Short enough that a crash loses seconds, long enough that a ninety-minute
 * lecture is about 1,350 writes rather than tens of thousands. */
export const SLICE_MS = 4_000;

/** Speech, mono: 64 kb/s AAC is about 43 MB for ninety minutes. */
const BITS_PER_SECOND = 64_000;

/** In order of preference. WebKit — the app's webview — produces AAC in MP4;
 * the others are for a Chromium webview should the shell ever change. */
const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
];

function chooseMime(): string {
  const supports = (mime: string) =>
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported(mime);
  return MIME_CANDIDATES.find(supports) ?? '';
}

function baseMime(mime: string, fallback: string): string {
  return (mime || fallback).split(';')[0]!.trim() || 'audio/mp4';
}

function unavailableFrom(error: unknown): RecorderUnavailableError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new RecorderUnavailableError('denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new RecorderUnavailableError('no_device');
  }
  return new RecorderUnavailableError('unsupported', String(error));
}

/** What a recording uses when Settings has nothing to say — also the
 * defaults `migrateSettings` fills in. ×2 (+6 dB) because the platform's own
 * level was found too quiet for a lecture on the first real recording. */
export const DEFAULT_RECORDING_INPUT: RecordingInput = {
  deviceId: null,
  gain: 2,
  autoGain: true,
  noiseSuppression: false,
};

function audioContextClass(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/** The microphone as configured, and the stream to encode. */
interface OpenInput {
  /** The raw microphone: its track ending means the device went away. */
  microphone: MediaStream;
  /** What the encoder records — the microphone after gain and limiter. */
  stream: MediaStream;
  /** Start reporting level, 0–1, a few times a second. */
  meter(onLevel: (level: number) => void): () => void;
  close(): void;
}

async function openInput(input: RecordingInput): Promise<OpenInput> {
  let microphone: MediaStream;
  try {
    microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(input.deviceId ? { deviceId: { exact: input.deviceId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        // Never the platform's: it starts low and takes seconds to adapt, so
        // every recording opened on a near-silent first sentence (found on a
        // real one, 2026-09-28: −50 dBFS for 3.5 s, then +25 dB). Automatic
        // level is the leveller in the graph below, even from sample one.
        autoGainControl: false,
        noiseSuppression: input.noiseSuppression,
      },
    });
  } catch (error) {
    throw unavailableFrom(error);
  }
  const release = () => microphone.getTracks().forEach((track) => track.stop());

  const Context = audioContextClass();
  if (!Context) {
    return {
      microphone,
      stream: microphone,
      meter: () => () => undefined,
      close: release,
    };
  }

  // One context per session, closed with it, so neither the gain stage nor
  // the meter can outlive the recording they belong to.
  const context = new Context();
  void context.resume().catch(() => undefined);
  const source = context.createMediaStreamSource(microphone);
  let tail: AudioNode = source;
  let stream = microphone;
  if (input.gain !== 1 || input.autoGain) {
    const gain = context.createGain();
    gain.gain.value = input.gain;
    let chain: AudioNode = source.connect(gain);
    if (input.autoGain) {
      // The leveller: a gentle compressor whose own makeup gain lifts quiet
      // speech (+11 dB on the test recording) while loud passages barely
      // move. Tuned offline on a real lecture recording; the room's silence
      // stays where it was, so pauses do not fill with hiss.
      const leveller = context.createDynamicsCompressor();
      leveller.threshold.value = -24;
      leveller.knee.value = 10;
      leveller.ratio.value = 4;
      leveller.attack.value = 0.01;
      leveller.release.value = 0.3;
      chain = chain.connect(leveller);
    }
    // A limiter, not a compressor: only what would pass full scale is held
    // down. −6 dB because a Web Audio compressor has no look-ahead and
    // overshoots its threshold by a few dB on a sharp consonant.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.25;
    const destination = context.createMediaStreamDestination();
    chain.connect(limiter).connect(destination);
    tail = limiter;
    stream = destination.stream;
  }

  return {
    microphone,
    stream,
    meter(onLevel) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      tail.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        // Speech sits around 0.02–0.1 RMS; the fourth root spreads it across
        // the meter instead of leaving it pinned at the bottom.
        onLevel(Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.6));
      }, 120);
      return () => {
        window.clearInterval(timer);
        onLevel(0);
      };
    },
    close() {
      release();
      void context.close().catch(() => undefined);
    },
  };
}

export function createMediaRecorderAdapter(sink: RecordingSink): RecorderAdapter {
  return {
    supported: () =>
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof MediaRecorder !== 'undefined',

    async start(request: RecorderStartRequest): Promise<RecorderSession> {
      if (!this.supported()) throw new RecorderUnavailableError('unsupported');

      const opened = await openInput(request.input ?? DEFAULT_RECORDING_INPUT);
      const { stream } = opened;
      const releaseStream = () => opened.close();

      const requested = chooseMime();
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          ...(requested ? { mimeType: requested } : {}),
          audioBitsPerSecond: BITS_PER_SECOND,
        });
      } catch (error) {
        releaseStream();
        throw unavailableFrom(error);
      }
      const mime = baseMime(recorder.mimeType, requested);

      try {
        await sink.begin(request.id, request.noteId, mime);
      } catch (error) {
        releaseStream();
        throw error;
      }

      const stopMeter = request.onLevel ? opened.meter(request.onLevel) : () => undefined;

      // Slices are written strictly in order: an MP4 fragment appended ahead
      // of the one before it is a corrupt file.
      let writes: Promise<void> = Promise.resolve();
      let failed = false;
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        stopMeter();
        if (recorder.state !== 'inactive') recorder.stop();
        releaseStream();
        request.onFailure?.(error);
      };
      recorder.addEventListener('dataavailable', (event: BlobEvent) => {
        if (!event.data.size) return;
        writes = writes
          .then(() => (failed ? undefined : sink.append(request.id, event.data)))
          .catch(fail);
      });
      recorder.addEventListener('error', (event) => fail(event));
      // A microphone unplugged mid-lecture ends the track; say so rather than
      // keep a recording running that is recording nothing.
      opened.microphone
        .getAudioTracks()[0]
        ?.addEventListener('ended', () =>
          fail(new RecorderUnavailableError('no_device', 'input device went away')),
        );

      const stopped = new Promise<void>((resolve) =>
        recorder.addEventListener('stop', () => resolve(), { once: true }),
      );
      recorder.start(SLICE_MS);
      const startedAt = Date.now();

      async function halt(): Promise<void> {
        stopMeter();
        if (recorder.state !== 'inactive') {
          recorder.stop();
          await stopped;
        }
        releaseStream();
        // The final `dataavailable` fires before `stop`; its write is queued
        // by the time `stopped` resolves.
        await writes;
      }

      return {
        id: request.id,
        mime,
        startedAt,
        async stop() {
          await halt();
          return sink.finish(request.id);
        },
        async cancel() {
          await halt();
          await sink.discard(request.id);
        },
      };
    },

    async listInputs() {
      if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return [];
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      return devices
        .filter((device) => device.kind === 'audioinput' && device.deviceId !== 'default')
        .map((device) => ({ id: device.deviceId, label: device.label }));
    },

    async monitor(input, onLevel) {
      if (!this.supported()) throw new RecorderUnavailableError('unsupported');
      const opened = await openInput(input);
      const stopMeter = opened.meter(onLevel);
      return () => {
        stopMeter();
        opened.close();
      };
    },

    interrupted: () => sink.interrupted(),
    recover: (id) => sink.finish(id),
    discard: (id) => sink.discard(id),
  };
}
