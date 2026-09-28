import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/adapters';
import { migrateSettings } from './settingsStore';

describe('recording settings', () => {
  it('start louder than the platform, with noise reduction off', () => {
    expect(migrateSettings({}).recording).toEqual(DEFAULT_SETTINGS.recording);
    expect(DEFAULT_SETTINGS.recording.gain).toBe(2);
    expect(DEFAULT_SETTINGS.recording.noiseSuppression).toBe(false);
  });

  it('keep a hand-edited file inside what the limiter can hold', () => {
    const recording = migrateSettings({
      recording: { deviceId: '', gain: 40, autoGain: 'yes', noiseSuppression: true },
    } as never).recording;
    expect(recording).toEqual({
      deviceId: null,
      gain: 4,
      autoGain: true,
      noiseSuppression: true,
      transcription: DEFAULT_SETTINGS.recording.transcription,
    });
    expect(migrateSettings({ recording: { gain: 0.1 } } as never).recording.gain).toBe(1);
  });

  it('transcribe on this Mac unless the student chose otherwise', () => {
    expect(migrateSettings({}).recording.transcription).toEqual({
      engineId: 'apple-speech',
      language: 'auto',
      useCourseVocabulary: true,
    });
    const kept = migrateSettings({
      recording: {
        transcription: {
          engineId: 'mistral-api',
          language: 'fr',
          useCourseVocabulary: false,
        },
      },
    } as never).recording.transcription;
    expect(kept).toEqual({
      engineId: 'mistral-api',
      language: 'fr',
      useCourseVocabulary: false,
    });
    const edited = migrateSettings({
      recording: { transcription: { engineId: 'whisper', language: 'de' } },
    } as never).recording.transcription;
    expect(edited.engineId).toBe('apple-speech');
    expect(edited.language).toBe('auto');
  });
});
