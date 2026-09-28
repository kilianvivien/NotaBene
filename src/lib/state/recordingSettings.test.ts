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
    });
    expect(migrateSettings({ recording: { gain: 0.1 } } as never).recording.gain).toBe(1);
  });
});
