import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@/lib/schema';
import {
  createMediaRecorderAdapter,
  SLICE_MS,
  type RecordingSink,
} from './mediaRecorderAdapter';
import { RecorderUnavailableError } from './RecorderAdapter';

/** Enough of `MediaRecorder` to drive: `emit` hands the adapter a slice the
 * way the encoder would every `timeslice`. */
class FakeRecorder extends EventTarget {
  static last: FakeRecorder | null = null;
  static isTypeSupported = (mime: string) => mime.startsWith('audio/mp4');
  state: 'inactive' | 'recording' = 'inactive';
  timeslice = 0;
  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    super();
    FakeRecorder.last = this;
  }
  get mimeType() {
    return this.options.mimeType ?? '';
  }
  start(timeslice: number) {
    this.state = 'recording';
    this.timeslice = timeslice;
  }
  stop() {
    this.state = 'inactive';
    // The final slice arrives before `stop`, as in WebKit.
    this.emit('333');
    this.dispatchEvent(new Event('stop'));
  }
  emit(text: string) {
    const event = new Event('dataavailable') as Event & { data: Blob };
    event.data = new Blob([text]);
    this.dispatchEvent(event);
  }
}

const track = Object.assign(new EventTarget(), { stop: vi.fn() });
const stream = {
  getTracks: () => [track],
  getAudioTracks: () => [track],
} as unknown as MediaStream;

function memorySink() {
  // Slices are told apart by size: jsdom's `Blob` has no `text()`.
  const written: number[] = [];
  const sink: RecordingSink & { written: number[] } = {
    written,
    begin: vi.fn(async () => undefined),
    // Slow first write: a later slice must still land after it.
    append: vi.fn(async (_id: string, slice: Blob) => {
      if (slice.size === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      written.push(slice.size);
    }),
    finish: vi.fn(async () => ({ id: 'hash' }) as Asset),
    discard: vi.fn(async () => undefined),
    interrupted: vi.fn(async () => []),
  };
  return sink;
}

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecorder.last = null;
});

describe('createMediaRecorderAdapter', () => {
  it('records AAC in slices and writes them in order before finishing', async () => {
    const sink = memorySink();
    const adapter = createMediaRecorderAdapter(sink);

    const session = await adapter.start({ id: 'rec-1', noteId: 'note-1' });
    expect(session.mime).toBe('audio/mp4');
    expect(sink.begin).toHaveBeenCalledWith('rec-1', 'note-1', 'audio/mp4');
    expect(FakeRecorder.last?.timeslice).toBe(SLICE_MS);

    FakeRecorder.last!.emit('1');
    FakeRecorder.last!.emit('22');
    const asset = await session.stop();

    expect(sink.written).toEqual([1, 2, 3]);
    expect(sink.finish).toHaveBeenCalledWith('rec-1');
    expect(asset.id).toBe('hash');
    expect(track.stop).toHaveBeenCalled();
  });

  it('names a refused microphone as refused', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('no', 'NotAllowedError');
        }),
      },
    });
    const adapter = createMediaRecorderAdapter(memorySink());

    const error = await adapter
      .start({ id: 'rec-1', noteId: 'note-1' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RecorderUnavailableError);
    expect((error as RecorderUnavailableError).reason).toBe('denied');
  });

  it('reports a failed write once and stops capturing', async () => {
    const sink = memorySink();
    sink.append = vi.fn(async () => {
      throw new Error('disk full');
    });
    const onFailure = vi.fn();
    const adapter = createMediaRecorderAdapter(sink);
    await adapter.start({ id: 'rec-1', noteId: 'note-1', onFailure });

    FakeRecorder.last!.emit('one');
    FakeRecorder.last!.emit('two');
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(FakeRecorder.last!.state).toBe('inactive');
  });

  it('throws the audio away only on cancel', async () => {
    const sink = memorySink();
    const session = await createMediaRecorderAdapter(sink).start({
      id: 'rec-1',
      noteId: 'note-1',
    });
    await session.cancel();
    expect(sink.discard).toHaveBeenCalledWith('rec-1');
    expect(sink.finish).not.toHaveBeenCalled();
  });

  it('asks for the chosen microphone with the chosen processing', async () => {
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const session = await createMediaRecorderAdapter(memorySink()).start({
      id: 'rec-1',
      noteId: 'note-1',
      input: { deviceId: 'usb-mic', gain: 1, autoGain: true, noiseSuppression: true },
    });
    // Automatic level is ours, in the graph; the platform's ramps up over
    // the first seconds of every recording and is never asked for.
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: 'usb-mic' },
        autoGainControl: { exact: false },
        noiseSuppression: true,
        echoCancellation: { exact: false },
      }),
    });
    await session.cancel();
  });

  it.each(['autoGainControl', 'echoCancellation'] as const)(
    'releases the microphone without writing when %s remains enabled',
    async (processing) => {
      const stop = vi.fn();
      const processedTrack = { stop, getSettings: () => ({ [processing]: true }) };
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({
            getTracks: () => [processedTrack],
            getAudioTracks: () => [processedTrack],
          })),
        },
      });
      const sink = memorySink();
      await expect(
        createMediaRecorderAdapter(sink).start({ id: 'rec-1', noteId: 'note-1' }),
      ).rejects.toMatchObject({ reason: 'unsupported' });
      expect(stop).toHaveBeenCalledOnce();
      expect(sink.begin).not.toHaveBeenCalled();
      expect(FakeRecorder.last).toBeNull();
    },
  );
});
