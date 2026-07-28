import { Cloud, ExternalLink, Loader2, Volume2 } from 'lucide-react';
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
  secrets,
  ttsRegistry,
  type TtsEngineId,
  type TtsEngineSummary,
  type TtsVoice,
} from '@/lib/adapters';
import { secretKeyFor } from '@/lib/ai';
import { listPodcastVoicesCommand } from '@/lib/commands';
import { useSpeechStore } from '@/lib/state/speechStore';
import { useSettingsStore } from '@/lib/state/settingsStore';

const DISPLAYED_ENGINES: TtsEngineId[] = ['system', 'mistral-api'];
const RATES = [0.8, 0.9, 1, 1.15, 1.3];

export function SpeechSettings() {
  const { t } = useTranslation();
  const speech = useSettingsStore((state) => state.settings.speech);
  const locale = useSettingsStore((state) => state.settings.locale);
  const update = useSettingsStore((state) => state.update);
  const [engines, setEngines] = useState<TtsEngineSummary[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [mistralKey, setMistralKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
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
  }, [locale, speech.engineId, mistralConfigured]);

  // macOS voices and hosted Voxtral voices both carry a real name; the
  // style/gender decoding this used to do was for the removed local presets.
  function voiceLabel(voice: TtsVoice): string {
    return `${voice.name} · ${voice.locale}`;
  }

  async function selectEngine(engineId: TtsEngineId) {
    if (engineId !== speech.engineId) useSpeechStore.getState().stop();
    await update({ speech: { ...speech, engineId } });
  }

  async function saveMistralKey() {
    const key = mistralKey.trim();
    if (!key) return;
    setWorking(true);
    setError('');
    setKeySaved(false);
    try {
      await secrets.set(secretKeyFor('mistral'), key);
      setMistralKey('');
      setKeySaved(true);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
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

      <FieldSection title={t('speech.mistralTitle')}>
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

              <div className="mt-3 flex gap-1.5">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={mistralKey}
                  placeholder={
                    mistralConfigured
                      ? t('speech.mistralKeyStored')
                      : t('speech.mistralKeyPlaceholder')
                  }
                  onChange={(event) => {
                    setMistralKey(event.target.value);
                    setKeySaved(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveMistralKey();
                  }}
                  aria-label={t('speech.mistralKey')}
                  className="h-8 min-w-0 flex-1 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
                />
                <GlassButton
                  size="sm"
                  disabled={!mistralKey.trim() || working}
                  onClick={() => void saveMistralKey()}
                >
                  {working ? <Loader2 size={12} className="animate-spin" /> : null}
                  {t('speech.saveKey')}
                </GlassButton>
              </div>

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
                <a
                  href="https://console.mistral.ai/api-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-nb-text-3 hover:text-nb-text-2"
                >
                  {t('speech.getMistralKey')}
                  <ExternalLink size={10} aria-hidden />
                </a>
                {keySaved && (
                  <span className="text-[11px] text-nb-text-3">
                    {t('speech.keySaved')}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </FieldSection>

      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </div>
  );
}
