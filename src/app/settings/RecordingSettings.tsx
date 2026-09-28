/**
 * Settings → Recording (plan §10.0).
 *
 * How the microphone is read for a lecture: which input, how loud, and which
 * of the platform's voice-call processing to keep. The level test listens
 * without recording, so a student can set the level in the room before the
 * lecture starts rather than discover afterwards that it was too quiet.
 *
 * Transcription will live here too (plan §10.3). Its section says so now, in
 * one line, rather than pretending the feature exists.
 */
import { Loader2, Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FieldNote,
  FieldRow,
  FieldSection,
  FieldToggle,
  GlassButton,
  GlassSelect,
} from '@/components/glass';
import {
  RECORDING_GAIN,
  RecorderUnavailableError,
  recorder,
  type AudioInputDevice,
  type RecordingSettings as RecordingSettingsValue,
} from '@/lib/adapters';
import { useRecordingStore } from '@/lib/state/recordingStore';
import { useSettingsStore } from '@/lib/state/settingsStore';

/** Gain as the student reads it: "+6 dB" means something; "×2" less so. */
function decibels(gain: number): string {
  const db = 20 * Math.log10(gain);
  return db < 0.05 ? '0 dB' : `+${db.toFixed(db < 10 ? 1 : 0)} dB`;
}

export function RecordingSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings.recording);
  const update = useSettingsStore((state) => state.update);
  const recording = useRecordingStore((state) => state.status !== 'idle');
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [testing, setTesting] = useState<'off' | 'starting' | 'on'>('off');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const stopTest = useRef<(() => void) | null>(null);
  const supported = recorder.supported();

  function set(patch: Partial<RecordingSettingsValue>) {
    void update({ recording: { ...settings, ...patch } });
  }

  const refreshDevices = () => void recorder.listInputs().then(setDevices);
  useEffect(refreshDevices, []);

  // Leaving the pane, or closing Settings, lets go of the microphone.
  useEffect(() => () => stopTest.current?.(), []);

  function endTest() {
    stopTest.current?.();
    stopTest.current = null;
    setTesting('off');
    setLevel(0);
  }

  async function startTest(input: RecordingSettingsValue) {
    endTest();
    setError('');
    setTesting('starting');
    try {
      stopTest.current = await recorder.monitor(input, setLevel);
      setTesting('on');
      // Names arrive once the microphone has been allowed.
      refreshDevices();
    } catch (cause) {
      setTesting('off');
      setError(
        cause instanceof RecorderUnavailableError
          ? t(`recording.unavailable.${cause.reason}`)
          : t('recording.startFailed'),
      );
    }
  }

  // A running test follows every change, so the meter answers the slider.
  const settingsKey = JSON.stringify(settings);
  const lastKey = useRef(settingsKey);
  useEffect(() => {
    if (lastKey.current === settingsKey) return;
    lastKey.current = settingsKey;
    if (stopTest.current) void startTest(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the value
  }, [settingsKey]);

  if (!supported) {
    return <FieldNote tone="notice">{t('recordingSettings.desktopOnly')}</FieldNote>;
  }

  const unnamed = devices.every((device) => !device.label);
  const bars = 20;
  const lit = Math.round(level * bars);

  return (
    <div className="space-y-5">
      <FieldSection title={t('recordingSettings.inputSection')}>
        <FieldRow
          label={t('recordingSettings.microphone')}
          hint={unnamed ? t('recordingSettings.namesHint') : undefined}
        >
          <GlassSelect
            label={t('recordingSettings.microphone')}
            value={settings.deviceId ?? ''}
            onChange={(event) => set({ deviceId: event.target.value || null })}
          >
            <option value="">{t('recordingSettings.systemDefault')}</option>
            {devices.map((device, index) => (
              <option key={device.id} value={device.id}>
                {device.label || t('recordingSettings.unnamed', { number: index + 1 })}
              </option>
            ))}
          </GlassSelect>
        </FieldRow>

        <FieldRow
          label={t('recordingSettings.gain')}
          hint={t('recordingSettings.gainHint')}
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={RECORDING_GAIN.min}
              max={RECORDING_GAIN.max}
              step={0.25}
              value={settings.gain}
              aria-label={t('recordingSettings.gain')}
              aria-valuetext={decibels(settings.gain)}
              onChange={(event) => set({ gain: Number(event.target.value) })}
              className="min-w-0 flex-1 accent-[var(--nb-accent)]"
            />
            <span className="w-14 shrink-0 text-right text-[12px] tabular-nums text-nb-text-2">
              {decibels(settings.gain)}
            </span>
          </div>
        </FieldRow>

        <FieldRow
          label={t('recordingSettings.test')}
          hint={t('recordingSettings.testHint')}
        >
          <div className="flex items-center gap-3">
            <GlassButton
              size="sm"
              disabled={recording || testing === 'starting'}
              onClick={() => (testing === 'on' ? endTest() : void startTest(settings))}
            >
              {testing === 'starting' ? (
                <Loader2 size={13} className="animate-spin" aria-hidden />
              ) : testing === 'on' ? (
                <Square size={12} aria-hidden />
              ) : (
                <Mic size={13} aria-hidden />
              )}
              {testing === 'on'
                ? t('recordingSettings.stopTest')
                : t('recordingSettings.startTest')}
            </GlassButton>
            <span
              className="flex h-3 min-w-0 flex-1 items-center gap-[2px]"
              role="meter"
              aria-label={t('recordingSettings.level')}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={Number(level.toFixed(2))}
            >
              {Array.from({ length: bars }, (_, bar) => (
                <span
                  key={bar}
                  className="h-full flex-1 rounded-[1px]"
                  style={{
                    background:
                      bar < lit
                        ? bar >= bars - 2
                          ? 'var(--nb-danger)'
                          : 'var(--nb-accent)'
                        : 'var(--nb-active)',
                  }}
                />
              ))}
            </span>
          </div>
        </FieldRow>
        {recording && <FieldNote>{t('recordingSettings.busy')}</FieldNote>}
        {error && <FieldNote tone="danger">{error}</FieldNote>}
      </FieldSection>

      <FieldSection title={t('recordingSettings.processingSection')}>
        <FieldRow
          label={t('recordingSettings.autoGain')}
          hint={t('recordingSettings.autoGainHint')}
          align="end"
        >
          <FieldToggle
            label={t('recordingSettings.autoGain')}
            checked={settings.autoGain}
            onChange={(autoGain) => set({ autoGain })}
          />
        </FieldRow>
        <FieldRow
          label={t('recordingSettings.noiseSuppression')}
          hint={t('recordingSettings.noiseSuppressionHint')}
          align="end"
        >
          <FieldToggle
            label={t('recordingSettings.noiseSuppression')}
            checked={settings.noiseSuppression}
            onChange={(noiseSuppression) => set({ noiseSuppression })}
          />
        </FieldRow>
        <FieldNote>{t('recordingSettings.appliesNext')}</FieldNote>
      </FieldSection>

      <FieldSection
        title={t('recordingSettings.transcriptionSection')}
        description={t('recordingSettings.transcriptionBody')}
      >
        <FieldNote tone="notice">{t('recordingSettings.transcriptionLater')}</FieldNote>
      </FieldSection>
    </div>
  );
}
