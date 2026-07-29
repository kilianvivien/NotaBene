import { describe, expect, it } from 'vitest';
import { createTtsEngineRegistry } from '@/lib/adapters/tts/ttsEngineRegistry';
import type {
  TtsEngine,
  TtsEngineCapabilities,
  TtsEngineState,
} from '@/lib/adapters/tts/TtsEngine';
import { migrateSettings } from '@/lib/state/settingsStore';
import { LOCAL_MODEL_REVISIONS } from '@/lib/adapters';
import {
  normalizeSpeechText,
  normalizeVoxtralSpeechText,
} from './normalizeSpeechText';
import {
  isLikelyIncompleteVoxtralAudio,
  prioritizeVoicesForLocale,
  speechChunks,
} from '@/lib/commands/studyCommands';

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
        localModelRevisions: {},
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
        localModelRevisions: {},
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

  it('preserves a managed local engine only with its pinned revision marker', () => {
    const migrated = migrateSettings({
      speech: {
        engineId: 'kokoro-local',
        voicesByEngine: { 'kokoro-local': 'ff_siwis' },
        localModelRevisions: {
          'kokoro-local': LOCAL_MODEL_REVISIONS['kokoro-local'],
        },
        playbackRate: 1,
        fallbackToSystem: false,
      },
    });
    expect(migrated.speech.engineId).toBe('kokoro-local');
    expect(migrated.speech.voicesByEngine['kokoro-local']).toBe('ff_siwis');
  });
});

describe('engine registry', () => {
  it('exposes capabilities and state without guessing from the id', async () => {
    const registry = createTtsEngineRegistry(
      fakeEngine('system'),
      fakeEngine('voxtral-local', { kind: 'not_configured' }),
      fakeEngine('kokoro-local', { kind: 'not_configured' }),
      fakeEngine('mistral-api', { kind: 'not_configured' }),
      fakeEngine('gemini-api', { kind: 'not_configured' }),
    );
    await expect(registry.available()).resolves.toEqual([
      expect.objectContaining({ id: 'system', state: { kind: 'ready' } }),
      expect.objectContaining({
        id: 'voxtral-local',
        state: { kind: 'not_configured' },
      }),
      expect.objectContaining({
        id: 'kokoro-local',
        state: { kind: 'not_configured' },
      }),
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
      fakeEngine('voxtral-local'),
      fakeEngine('kokoro-local'),
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

  it('sanitizes invisible Voxtral input and supplies terminal punctuation', () => {
    expect(normalizeVoxtralSpeechText('A\u200b strange——prompt!!!', 'en')).toBe(
      'A strange - prompt!',
    );
    expect(normalizeVoxtralSpeechText('No terminator', 'en')).toBe('No terminator.');
  });
});

describe('speech chunking', () => {
  it('keeps normal sentences intact and bounds pathological long text', () => {
    const chunks = speechChunks(
      `First sentence. Second sentence! ${'unbroken '.repeat(120)}`,
    );
    expect(chunks[0]).toBe('First sentence. Second sentence!');
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(640);
  });

  it('uses short, punctuated chunks for Voxtral in long notes and podcasts', () => {
    const chunks = speechChunks(
      `A useful opening sentence. ${'A deliberately long clause with several words, '.repeat(20)}`,
      { engineId: 'voxtral-local' },
    );
    expect(chunks.length).toBeGreaterThan(2);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(
      180,
    );
    expect(chunks.every((chunk) => /[.!?…]$/.test(chunk))).toBe(true);
  });

  it('flags only implausibly short Voxtral output for recovery', () => {
    const text = 'These twelve ordinary words should require more than a single second to speak.';
    expect(isLikelyIncompleteVoxtralAudio(text, 900)).toBe(true);
    expect(isLikelyIncompleteVoxtralAudio(text, 4_000)).toBe(false);
    expect(isLikelyIncompleteVoxtralAudio('A short phrase.', 300)).toBe(false);
  });
});

describe('speech voice language', () => {
  it('prioritizes the UI language without hiding voices in other languages', () => {
    const voices = [
      { id: 'heart', name: 'Heart', locale: 'en', quality: 'enhanced' as const },
      { id: 'siwis', name: 'Siwis', locale: 'fr', quality: 'enhanced' as const },
      { id: 'anna', name: 'Anna', locale: 'de-DE', quality: 'standard' as const },
    ];

    expect(prioritizeVoicesForLocale(voices, 'fr-FR').map((voice) => voice.id)).toEqual([
      'siwis',
      'heart',
      'anna',
    ]);
    expect(prioritizeVoicesForLocale(voices, 'en-US').map((voice) => voice.id)).toEqual([
      'heart',
      'siwis',
      'anna',
    ]);
  });
});
