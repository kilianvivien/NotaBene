import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationRequest } from './DictationAdapter';
import { tauriDictationTransport } from './tauriDictationAdapter';

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  output: null as null | { onmessage: (event: unknown) => void },
  finish: () => {},
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: bridge.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

function options(signal = new AbortController().signal): DictationRequest {
  return {
    apiKey: 'key',
    input: { deviceId: null, gain: 2, autoGain: true, noiseSuppression: false },
    signal,
    vocabulary: ['Alder Creek Design'],
    onText: vi.fn(),
    onLevel: vi.fn(),
    onFailure: vi.fn(),
  };
}
beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.output = null;
  bridge.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === 'dictation_run') {
      bridge.output = args.output as typeof bridge.output;
      const running = new Promise<void>((resolve) => {
        bridge.finish = resolve;
      });
      queueMicrotask(() => bridge.output!.onmessage({ type: 'ready' }));
      return running;
    }
    if (command === 'dictation_audio' && args.data === null) {
      bridge.output!.onmessage({ type: 'transcription.done', text: 'Bonjour le monde.' });
      bridge.finish();
    }
    if (command === 'dictation_cancel') bridge.finish();
    return Promise.resolve();
  });
});

describe('Voxtral realtime IPC transport', () => {
  it('preserves delta spacing and final text, sending only PCM over audio IPC', async () => {
    const request = options();
    const session = await tauriDictationTransport.connect(request, 16_000);
    bridge.output!.onmessage({ type: 'transcription.text.delta', text: 'Bonjour' });
    bridge.output!.onmessage({ type: 'transcription.text.delta', text: ' le monde' });
    await session.send(new Uint8Array([0, 0]));
    await session.finish();
    expect(vi.mocked(request.onText).mock.calls).toEqual([
      ['Bonjour'],
      [' le monde'],
      ['.'],
    ]);
    expect(bridge.invoke).toHaveBeenCalledWith(
      'dictation_run',
      expect.objectContaining({
        apiKey: 'key',
        sampleRate: 16_000,
        vocabulary: ['Alder Creek Design'],
      }),
    );
    expect(bridge.invoke).toHaveBeenCalledWith(
      'dictation_audio',
      expect.objectContaining({ data: 'AAA=' }),
    );
    expect(request.onFailure).not.toHaveBeenCalled();
    await session.cancel();
  });

  it('rejects malformed stream events and closes the session', async () => {
    const request = options();
    const session = await tauriDictationTransport.connect(request, 16_000);
    bridge.output!.onmessage({
      type: 'transcription.text.delta',
      text: { untrusted: true },
    });
    expect(request.onFailure).toHaveBeenCalledOnce();
    expect(request.onText).not.toHaveBeenCalled();
    await expect(session.send(new Uint8Array([0, 0]))).rejects.toThrow(
      'DICTATION_CLOSED',
    );
    await session.cancel();
  });

  it('cancels during connection without uploading audio', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      tauriDictationTransport.connect(options(controller.signal), 16_000),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      bridge.invoke.mock.calls.some(([command]) => command === 'dictation_audio'),
    ).toBe(false);
    expect(bridge.invoke).toHaveBeenCalledWith('dictation_cancel', expect.anything());
  });
});
