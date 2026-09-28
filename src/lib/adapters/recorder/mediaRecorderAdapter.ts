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

/**
 * RMS of the input, a few times a second. Its own `AudioContext` rather than
 * anything shared with playback, and closed with the session, so the meter
 * can never outlive the recording it describes.
 */
function startMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Context) return () => undefined;
  const context = new Context();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    // Speech sits around 0.02–0.1 RMS; the square root spreads it across the
    // meter instead of leaving it pinned at the bottom.
    onLevel(Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.6));
  }, 120);
  return () => {
    window.clearInterval(timer);
    onLevel(0);
    void context.close().catch(() => undefined);
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

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false },
        });
      } catch (error) {
        throw unavailableFrom(error);
      }
      const releaseStream = () => stream.getTracks().forEach((track) => track.stop());

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

      const stopMeter = request.onLevel
        ? startMeter(stream, request.onLevel)
        : () => undefined;

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
      stream
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

    interrupted: () => sink.interrupted(),
    recover: (id) => sink.finish(id),
    discard: (id) => sink.discard(id),
  };
}
