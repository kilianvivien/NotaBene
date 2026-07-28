import { Download, HardDrive, Loader2, Trash2, Volume2 } from 'lucide-react';
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
  voxtralModel,
  type TtsEngineId,
  type TtsEngineSummary,
} from '@/lib/adapters';
import { useSettingsStore } from '@/lib/state/settingsStore';

const DISPLAYED_ENGINES: TtsEngineId[] = ['system', 'voxtral-local'];
const RATES = [0.8, 0.9, 1, 1.15, 1.3];

export function SpeechSettings() {
  const { t } = useTranslation();
  const speech = useSettingsStore((state) => state.settings.speech);
  const update = useSettingsStore((state) => state.update);
  const [engines, setEngines] = useState<TtsEngineSummary[]>([]);
  const [accepted, setAccepted] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

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

  const voxtral = engines.find((engine) => engine.id === 'voxtral-local');
  const state = voxtral?.state;

  useEffect(() => {
    if (state?.kind !== 'downloading' && state?.kind !== 'verifying') return;
    const timer = window.setInterval(() => void refresh(), 750);
    return () => window.clearInterval(timer);
  }, [refresh, state?.kind]);

  async function install(requireConsent = true) {
    if (requireConsent && !accepted) return;
    setWorking(true);
    setError('');
    try {
      await voxtralModel.install('CC-BY-NC-4.0');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    setWorking(true);
    setError('');
    try {
      await voxtralModel.remove();
      if (speech.engineId === 'voxtral-local') {
        await update({ speech: { ...speech, engineId: 'system' } });
      }
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
            onChange={(event) =>
              void update({
                speech: {
                  ...speech,
                  engineId: event.target.value as TtsEngineId,
                },
              })
            }
          >
            {DISPLAYED_ENGINES.map((id) => {
              const summary = engines.find((engine) => engine.id === id);
              const selectable =
                id === 'system' ||
                summary?.state.kind === 'installed' ||
                summary?.state.kind === 'ready';
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
              speech.engineId === 'voxtral-local'
                ? 'speech.privacyLocalModel'
                : 'speech.privacySystem',
            )}
          </span>
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
        title={t('speech.voxtralTitle')}
        description={t('speech.voxtralDescription')}
      >
        <div className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] p-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-nb-xs bg-[var(--nb-active)] p-2 text-nb-text-2">
              <HardDrive size={16} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] font-medium">Voxtral 4B TTS · MLX 4-bit</p>
                  <p className="text-[11px] text-nb-text-3">
                    mlx-community · ~2.5 GB · CC BY-NC 4.0
                  </p>
                </div>
                <span
                  className="rounded-full bg-[var(--nb-active)] px-2 py-0.5 text-[10px] text-nb-text-2"
                  aria-live="polite"
                >
                  {t(`speech.state_${state?.kind ?? 'loading'}`)}
                </span>
              </div>

              {state?.kind === 'unsupported' && (
                <FieldNote tone="danger">{state.reason}</FieldNote>
              )}
              {state?.kind === 'error' && (
                <FieldNote tone="danger">{state.message ?? state.code}</FieldNote>
              )}
              {state?.kind === 'downloading' && (
                <div className="mt-3">
                  <progress
                    className="h-1.5 w-full accent-[var(--nb-accent)]"
                    max={state.totalBytes}
                    value={state.downloadedBytes}
                    aria-label={t('speech.downloadProgress')}
                  />
                </div>
              )}

              {state?.kind === 'not_installed' && (
                <label className="mt-3 flex items-start gap-2 text-[11px] leading-snug text-nb-text-2">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(event) => setAccepted(event.target.checked)}
                    className="mt-0.5 accent-[var(--nb-accent)]"
                  />
                  <span>{t('speech.licenseConsent')}</span>
                </label>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {state?.kind === 'error' && state.recoverable && (
                  <GlassButton
                    size="sm"
                    variant="accent"
                    disabled={working}
                    onClick={() => void install(false)}
                  >
                    {working ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Download size={12} />
                    )}
                    {t('speech.retry')}
                  </GlassButton>
                )}
                {state?.kind === 'not_installed' && (
                  <GlassButton
                    size="sm"
                    variant="accent"
                    disabled={!accepted || working}
                    onClick={() => void install()}
                  >
                    {working ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Download size={12} />
                    )}
                    {t('speech.download')}
                  </GlassButton>
                )}
                {state?.kind === 'downloading' && (
                  <GlassButton
                    size="sm"
                    onClick={() => void voxtralModel.cancelInstall().then(refresh)}
                  >
                    {t('common.cancel')}
                  </GlassButton>
                )}
                {(state?.kind === 'installed' ||
                  state?.kind === 'ready' ||
                  state?.kind === 'error') && (
                  <>
                    {state.kind !== 'error' && (
                      <GlassButton
                        size="sm"
                        variant="accent"
                        onClick={() =>
                          void update({
                            speech: { ...speech, engineId: 'voxtral-local' },
                          })
                        }
                      >
                        <Volume2 size={12} />
                        {t('speech.useVoxtral')}
                      </GlassButton>
                    )}
                    <GlassButton
                      size="sm"
                      disabled={working}
                      onClick={() => void remove()}
                    >
                      <Trash2 size={12} />
                      {t('speech.remove')}
                    </GlassButton>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        <FieldNote>{t('speech.noBundleNotice')}</FieldNote>
        {error && <FieldNote tone="danger">{error}</FieldNote>}
      </FieldSection>
    </div>
  );
}
