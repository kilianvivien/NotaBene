import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInput } from '../recorder/mediaRecorderAdapter';
import { createMediaDictationAdapter, pcm16 } from './mediaDictationAdapter';
import type { DictationRequest } from './DictationAdapter';

vi.mock('../recorder/mediaRecorderAdapter', () => ({ openInput: vi.fn() }));

let node: FakeWorklet;
const closeMicrophone = vi.fn();
const closeContext = vi.fn(async () => {});
const finish = vi.fn(async () => {});
const cancel = vi.fn(async () => {});
const send = vi.fn(async (_bytes: Uint8Array) => {});
class FakeContext {
  sampleRate = 16_000;
  destination = {};
  resume = async () => {};
  close = closeContext;
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource = () => ({ connect: vi.fn() });
}
class FakeWorklet {
  constructor() {
    // The constructor exposes the simulated worklet to the test driver.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    node = this;
  }
  connect = vi.fn();
  disconnect = vi.fn();
  port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: vi.fn((message: string) => {
      if (message === 'flush') {
        this.emit(new Float32Array([0.25]));
        this.emit('flushed');
      }
    }),
  };
  emit(data: unknown) {
    this.port.onmessage?.({ data } as MessageEvent);
  }
}
function request(): DictationRequest {
  return {
    apiKey: 'secret',
    input: { deviceId: null, gain: 2, autoGain: true, noiseSuppression: false },
    vocabulary: [],
    signal: new AbortController().signal,
    onText: vi.fn(),
    onLevel: vi.fn(),
    onFailure: vi.fn(),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  vi.mocked(openInput).mockResolvedValue({
    microphone: { getAudioTracks: () => [new EventTarget()] } as unknown as MediaStream,
    stream: {} as MediaStream,
    close: closeMicrophone,
    meter: () => () => {},
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('ephemeral microphone dictation', () => {
  it('encodes clipped, finite samples as signed little-endian PCM', () => {
    expect([...pcm16(new Float32Array([-2, -1, 0, 1, 2, NaN]))]).toEqual([
      0, 128, 0, 128, 0, 0, 255, 127, 255, 127, 0, 0,
    ]);
  });

  it('releases the microphone before draining the final partial PCM frame', async () => {
    const session = await createMediaDictationAdapter({
      connect: async () => ({ send, finish, cancel }),
    }).start(request());
    node.emit(new Float32Array([-1, 1]));
    const stopped = session.stop();
    expect(closeMicrophone).toHaveBeenCalled();
    await stopped;
    expect(send.mock.calls.map(([bytes]) => [...bytes])).toEqual([
      [0, 128, 255, 127],
      [0, 32],
    ]);
    expect(finish).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
  });

  it('does not open the microphone for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = vi.fn();
    await expect(
      createMediaDictationAdapter({ connect }).start({
        ...request(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(openInput).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('releases audio resources after an upload failure', async () => {
    send.mockRejectedValueOnce(new Error('disconnected'));
    const options = request();
    const session = await createMediaDictationAdapter({
      connect: async () => ({ send, finish, cancel }),
    }).start(options);
    node.emit(new Float32Array([1]));
    await vi.waitFor(() => expect(options.onFailure).toHaveBeenCalledOnce());
    expect(closeMicrophone).toHaveBeenCalled();
    expect(closeContext).toHaveBeenCalled();
    await session.cancel();
    expect(finish).not.toHaveBeenCalled();
  });
});
