import { describe, expect, it } from 'vitest';
import { createTtsEngineRegistry } from '@/lib/adapters/tts/ttsEngineRegistry';
import type {
  TtsEngine,
  TtsEngineCapabilities,
  TtsEngineState,
} from '@/lib/adapters/tts/TtsEngine';
import { migrateSettings } from '@/lib/state/settingsStore';
import { normalizeSpeechText } from './normalizeSpeechText';

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
        engineId: 'mistral-api',
        voicesByEngine: { 'mistral-api': 'fr_female' },
        playbackRate: 0.9,
        fallbackToSystem: true,
      },
    });
    expect(migrated.speech.voicesByEngine['mistral-api']).toBe('fr_female');
    expect(migrated.speech.engineId).toBe('mistral-api');
  });

  it('preserves a configured Gemini voice', () => {
    const migrated = migrateSettings({
      speech: {
        engineId: 'gemini-api',
        voicesByEngine: { 'gemini-api': 'Kore' },
        playbackRate: 1,
        fallbackToSystem: false,
      },
    });
    expect(migrated.speech.voicesByEngine['gemini-api']).toBe('Kore');
    expect(migrated.speech.engineId).toBe('gemini-api');
  });

  it('retires a saved engine this build no longer ships', () => {
    const migrated = migrateSettings({
      speech: {
        engineId: 'voxtral-local',
        voicesByEngine: { 'voxtral-local': 'fr_female', system: 'Ava' },
        playbackRate: 0.9,
        fallbackToSystem: true,
      },
    } as unknown as Parameters<typeof migrateSettings>[0]);
    // Otherwise the app would ask a registry that has no such engine, and the
    // play button would fail for a reason the user cannot see or fix.
    expect(migrated.speech.engineId).toBe('system');
    expect(migrated.speech.voicesByEngine).toEqual({ system: 'Ava' });
    expect(migrated.speech.playbackRate).toBe(0.9);
  });
});

describe('engine registry', () => {
  it('exposes capabilities and state without guessing from the id', async () => {
    const registry = createTtsEngineRegistry(
      fakeEngine('system'),
      fakeEngine('mistral-api', { kind: 'not_configured' }),
      fakeEngine('gemini-api', { kind: 'not_configured' }),
    );
    await expect(registry.available()).resolves.toEqual([
      expect.objectContaining({ id: 'system', state: { kind: 'ready' } }),
      expect.objectContaining({
        id: 'mistral-api',
        state: { kind: 'not_configured' },
      }),
      expect.objectContaining({
        id: 'gemini-api',
        state: { kind: 'not_configured' },
      }),
    ]);
  });

  it('never materializes an unimplemented cloud fallback', () => {
    const registry = createTtsEngineRegistry(
      fakeEngine('system'),
      fakeEngine('mistral-api'),
      fakeEngine('gemini-api'),
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
});
