import { describe, expect, it } from 'vitest';
import { createTtsEngineRegistry } from '@/lib/adapters/tts/ttsEngineRegistry';
import type {
  TtsAudioEvent,
  TtsEngine,
  TtsEngineCapabilities,
  TtsEngineState,
} from '@/lib/adapters/tts/TtsEngine';
import { pcm16ToFloat32 } from '@/lib/audio/pcm';
import { encodeWav, parseWav } from '@/lib/podcast/wav';
import { migrateSettings } from '@/lib/state/settingsStore';
import { normalizeSpeechText, speechRequests } from './normalizeSpeechText';

const CAPABILITIES: TtsEngineCapabilities = {
  local: true,
  streaming: false,
  supportsRate: 'synthesis',
  supportsPitch: false,
  supportsVoiceCloning: false,
  sampleRateHz: 22_050,
  channels: 1,
  formats: ['wav'],
};

function fakeEngine(
  id: TtsEngine['id'],
  state: TtsEngineState = { kind: 'ready' },
): TtsEngine {
  return {
    id,
    async capabilities() {
      return CAPABILITIES;
    },
    async status() {
      return state;
    },
    async isAvailable() {
      return state.kind === 'ready';
    },
    async listVoices() {
      return [];
    },
    async *synthesizeStream(request): AsyncIterable<TtsAudioEvent> {
      yield {
        type: 'done',
        requestId: request.requestId,
        totalSamples: 0,
        durationMs: 0,
      };
    },
    async synthesize() {
      throw new Error('unused');
    },
  };
}

describe('speech settings migration', () => {
  it('moves the old system voice and rate without changing podcast choices', () => {
    const migrated = migrateSettings({
      podcast: {
        voiceId: 'Ava (Premium)',
        rate: 1.15,
        mode: 'dialogue',
        minutes: 10,
      },
    } as unknown as Parameters<typeof migrateSettings>[0]);

    expect(migrated.speech).toMatchObject({
      engineId: 'system',
      voicesByEngine: { system: 'Ava (Premium)' },
      playbackRate: 1.15,
      fallbackToSystem: false,
    });
    expect(migrated.podcast).toEqual({ mode: 'dialogue', minutes: 10 });
  });

  it('preserves an already migrated engine-scoped voice', () => {
    const migrated = migrateSettings({
      speech: {
        engineId: 'voxtral-local',
        voicesByEngine: { 'voxtral-local': 'fr_female' },
        playbackRate: 0.9,
        fallbackToSystem: true,
      },
    });
    expect(migrated.speech.voicesByEngine['voxtral-local']).toBe('fr_female');
    expect(migrated.speech.engineId).toBe('voxtral-local');
  });
});

describe('engine registry', () => {
  it('exposes capabilities and state without guessing from the id', async () => {
    const registry = createTtsEngineRegistry(
      fakeEngine('system'),
      fakeEngine('voxtral-local', { kind: 'not_installed' }),
      fakeEngine('mistral-api', { kind: 'not_configured' }),
    );
    await expect(registry.available()).resolves.toEqual([
      expect.objectContaining({ id: 'system', state: { kind: 'ready' } }),
      expect.objectContaining({
        id: 'voxtral-local',
        state: { kind: 'not_installed' },
      }),
      expect.objectContaining({
        id: 'mistral-api',
        state: { kind: 'not_configured' },
      }),
    ]);
  });

  it('never materializes an unimplemented cloud fallback', () => {
    const registry = createTtsEngineRegistry(
      fakeEngine('system'),
      fakeEngine('voxtral-local'),
      fakeEngine('mistral-api'),
    );
    expect(() => registry.get('openai-compatible')).toThrow(/not configured/);
  });
});

describe('deterministic speech normalization', () => {
  it('keeps spoken link labels while removing markdown, emoji, and code fences', () => {
    const normalized = normalizeSpeechText(
      '# Topic\nRead [the guide](https://example.com/x) & `remember` 🧪.\n```ts\nconst secret = 1\n```',
      'en',
    );
    expect(normalized).toContain('Read the guide and remember');
    for (const visual of ['#', '`', '[', ']', 'secret']) {
      expect(normalized).not.toContain(visual);
    }
    expect(normalized).not.toContain('🧪');
  });

  it('keeps every Voxtral request below the word and character ceilings', () => {
    const requests = speechRequests(`${'word '.repeat(700)}.`, 'en');
    expect(requests.length).toBeGreaterThan(2);
    for (const request of requests) {
      expect(request.split(/\s+/).length).toBeLessThanOrEqual(280);
      expect(request.length).toBeLessThanOrEqual(1_600);
    }
  });
});

describe('PCM streaming utilities', () => {
  it('decodes little-endian PCM16 into bounded Web Audio samples', () => {
    const bytes = new Uint8Array([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]);
    expect([...pcm16ToFloat32(bytes)]).toEqual([-1, 0, 1]);
    expect(() => pcm16ToFloat32(new Uint8Array([0]))).toThrow(/odd/);
  });

  it('wraps Voxtral PCM in one valid 24 kHz WAV', () => {
    const wav = encodeWav({
      format: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 },
      samples: new Uint8Array(48_000),
    });
    const parsed = parseWav(wav);
    expect(parsed.format).toEqual({
      sampleRate: 24_000,
      channels: 1,
      bitsPerSample: 16,
    });
    expect(parsed.samples).toHaveLength(48_000);
  });
});
