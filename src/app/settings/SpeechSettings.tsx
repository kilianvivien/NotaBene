import { Cloud, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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
  ttsRegistry,
  type TtsEngineId,
  type TtsEngineSummary,
  type TtsVoice,
} from '@/lib/adapters';
import { listPodcastVoicesCommand } from '@/lib/commands';
import { useSpeechStore } from '@/lib/state/speechStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { LocalSpeechModelCard } from './LocalSpeechModelCard';

const DISPLAYED_ENGINES: TtsEngineId[] = [
  'system',
  'kokoro-local',
  'voxtral-local',
  'mistral-api',
  'gemini-api',
];
const RATES = [0.8, 0.9, 1, 1.15, 1.3];

export function SpeechSettings() {
  const { t } = useTranslation();
  const speech = useSettingsStore((state) => state.settings.speech);
  const locale = useSettingsStore((state) => state.settings.locale);
  const update = useSettingsStore((state) => state.update);
  const openSettingsTab = useUiStore((state) => state.setSettingsTab);
  const [engines, setEngines] = useState<TtsEngineSummary[]>([]);
  const [error, setError] = useState('');
  const [voices, setVoices] = useState<TtsVoice[]>([]);

  const refresh = useCallback(async () => {
    try {
      setEngines(await ttsRegistry.available());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mistral = engines.find((engine) => engine.id === 'mistral-api');
  const mistralConfigured = mistral?.state.kind === 'ready';
  const gemini = engines.find((engine) => engine.id === 'gemini-api');
  const geminiConfigured = gemini?.state.kind === 'ready';

  useEffect(() => {
    let active = true;
    void listPodcastVoicesCommand(locale, speech.engineId).then((outcome) => {
      if (!active) return;
      if (!outcome.ok) {
        setVoices([]);
        return;
      }
      setVoices(outcome.value);
      const selected = speech.voicesByEngine[speech.engineId];
      if (!outcome.value.some((voice) => voice.id === selected)) {
        const first = outcome.value[0];
        if (first) {
          void update({
            speech: {
              ...speech,
              voicesByEngine: {
                ...speech.voicesByEngine,
                [speech.engineId]: first.id,
              },
            },
          });
        }
      }
    });
    return () => {
      active = false;
    };
    // Voice selection itself is intentionally absent so it cannot be reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, speech.engineId, mistralConfigured, geminiConfigured]);

  // Every engine now supplies the complete label it wants shown; the
  // style/gender decoding this used to do was for removed local presets.
  function voiceLabel(voice: TtsVoice): string {
    return `${voice.name} · ${voice.locale}`;
  }

  async function selectEngine(engineId: TtsEngineId) {
    if (engineId !== speech.engineId) useSpeechStore.getState().stop();
    await update({ speech: { ...speech, engineId } });
  }

  return (
    <div className="space-y-4">
      <FieldSection
        title={t('speech.engineTitle')}
        description={t('speech.engineDescription')}
      >
        <FieldRow label={t('speech.engine')}>
          <GlassSelect
            label={t('speech.engine')}
            value={speech.engineId}
            onChange={(event) => void selectEngine(event.target.value as TtsEngineId)}
          >
            {DISPLAYED_ENGINES.map((id) => {
              const summary = engines.find((engine) => engine.id === id);
              const selectable = id === 'system' || summary?.state.kind === 'ready';
              return (
                <option key={id} value={id} disabled={!selectable}>
                  {t(`speech.engine_${id}`)}
                </option>
              );
            })}
          </GlassSelect>
        </FieldRow>
        <FieldRow label={t('speech.privacy')}>
          <span className="text-[12px] text-nb-text-2">
            {t(
              speech.engineId === 'mistral-api'
                ? 'speech.privacyMistral'
                : speech.engineId === 'gemini-api'
                  ? 'speech.privacyGemini'
                  : speech.engineId === 'voxtral-local' ||
                      speech.engineId === 'kokoro-local'
                    ? 'speech.privacyLocal'
                    : 'speech.privacySystem',
            )}
          </span>
        </FieldRow>
        <FieldRow label={t('speech.voice')}>
          <GlassSelect
            label={t('speech.voice')}
            value={speech.voicesByEngine[speech.engineId] ?? ''}
            disabled={!voices.length}
            onChange={(event) =>
              void update({
                speech: {
                  ...speech,
                  voicesByEngine: {
                    ...speech.voicesByEngine,
                    [speech.engineId]: event.target.value,
                  },
                },
              })
            }
          >
            {voices.length ? (
              voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voiceLabel(voice)}
                </option>
              ))
            ) : (
              <option value="">{t('speech.noVoices')}</option>
            )}
          </GlassSelect>
        </FieldRow>
        <FieldRow label={t('speech.playbackRate')}>
          <GlassSelect
            label={t('speech.playbackRate')}
            value={String(speech.playbackRate)}
            onChange={(event) =>
              void update({
                speech: { ...speech, playbackRate: Number(event.target.value) },
              })
            }
          >
            {RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate.toFixed(2).replace(/0$/, '')}×
              </option>
            ))}
          </GlassSelect>
        </FieldRow>
        <FieldRow
          label={t('speech.fallback')}
          hint={t('speech.fallbackHint')}
          align="end"
        >
          <FieldToggle
            label={t('speech.fallback')}
            checked={speech.fallbackToSystem}
            onChange={(fallbackToSystem) =>
              void update({ speech: { ...speech, fallbackToSystem } })
            }
          />
        </FieldRow>
      </FieldSection>

      <FieldSection
        title={t('speech.localTitle')}
        description={t('speech.localDescription')}
      >
        <div className="space-y-2">
          <LocalSpeechModelCard id="kokoro-local" onChanged={refresh} />
          <LocalSpeechModelCard id="voxtral-local" onChanged={refresh} />
        </div>
      </FieldSection>

      <FieldSection
        title={t('speech.hostedTitle')}
        description={t('speech.hostedDescription')}
      >
        <div className="space-y-2">
          <div className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] p-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-nb-xs bg-[var(--nb-active)] p-2 text-nb-text-2">
                <Cloud size={16} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-medium">Voxtral TTS API</p>
                    <p className="text-[11px] text-nb-text-3">
                      {t('speech.mistralPricing')}
                    </p>
                  </div>
                  <span className="rounded-full bg-[var(--nb-active)] px-2 py-0.5 text-[10px] text-nb-text-2">
                    {t(`speech.state_${mistralConfigured ? 'ready' : 'not_configured'}`)}
                  </span>
                </div>

                <p className="mt-2 text-[11px] leading-snug text-nb-text-2">
                  {t('speech.mistralPrivacy')}
                </p>

                <p className="mt-2 text-[11px] leading-snug text-nb-text-2">
                  {t('speech.mistralSharedKey')}{' '}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => openSettingsTab('aiProviders')}
                  >
                    {t('settings.aiProviders')}
                  </button>
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {mistralConfigured && (
                    <GlassButton
                      size="sm"
                      variant="accent"
                      onClick={() => void selectEngine('mistral-api')}
                    >
                      <Volume2 size={12} />
                      {t('speech.useMistral')}
                    </GlassButton>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] p-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-nb-xs bg-[var(--nb-active)] p-2 text-nb-text-2">
                <Cloud size={16} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-medium">
                      Gemini 3.1 Flash TTS Preview
                    </p>
                    <p className="text-[11px] text-nb-text-3">
                      {t('speech.geminiPricing')}
                    </p>
                  </div>
                  <span className="rounded-full bg-[var(--nb-active)] px-2 py-0.5 text-[10px] text-nb-text-2">
                    {t(`speech.state_${geminiConfigured ? 'ready' : 'not_configured'}`)}
                  </span>
                </div>

                <p className="mt-2 text-[11px] leading-snug text-nb-text-2">
                  {t('speech.geminiPrivacy')}
                </p>

                <p className="mt-2 text-[11px] leading-snug text-nb-text-2">
                  {t('speech.geminiSharedKey')}{' '}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => openSettingsTab('aiProviders')}
                  >
                    {t('settings.aiProviders')}
                  </button>
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {geminiConfigured && (
                    <GlassButton
                      size="sm"
                      variant="accent"
                      onClick={() => void selectEngine('gemini-api')}
                    >
                      <Volume2 size={12} />
                      {t('speech.useGemini')}
                    </GlassButton>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </FieldSection>

      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </div>
  );
}
