/**
 * Settings → Recording → Transcription (plan §10.3).
 *
 * The engine, with the privacy line under it that says where the audio goes,
 * as the speech pane does for voices; the languages macOS can transcribe on
 * this Mac, each installed on the student's click (Apple's download, like a
 * dictation language); and the two defaults the dialog starts from.
 *
 * Mistral uses the key already set for the AI provider and speech. This pane
 * does not grow a third key field; it points at the one that exists.
 */
import { Download, Loader2 } from 'lucide-react';
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
  APPLE_LOCALES,
  asr,
  asrRegistry,
  type AsrEngineId,
  type AsrEngineSummary,
  type AsrLanguage,
  type TranscriptionSettings as TranscriptionSettingsValue,
} from '@/lib/adapters';
import type { AppleSpeechStatus } from '@/lib/schema';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';

const LANGUAGES: AsrLanguage[] = ['fr', 'en'];

type LanguageState = AppleSpeechStatus['languages'][number]['status'];

export function TranscriptionSettings() {
  const { t } = useTranslation();
  const recording = useSettingsStore((state) => state.settings.recording);
  const settings = recording.transcription;
  const update = useSettingsStore((state) => state.update);
  const openSettingsTab = useUiStore((state) => state.setSettingsTab);
  const [engines, setEngines] = useState<AsrEngineSummary[]>([]);
  const [languages, setLanguages] = useState<Partial<Record<AsrLanguage, LanguageState>>>(
    {},
  );
  const [installing, setInstalling] = useState<{
    language: AsrLanguage;
    fraction: number;
  } | null>(null);
  const [error, setError] = useState('');

  function set(patch: Partial<TranscriptionSettingsValue>) {
    void update({
      recording: { ...recording, transcription: { ...settings, ...patch } },
    });
  }

  const refresh = useCallback(async () => {
    setEngines(await asrRegistry.available().catch(() => []));
    const status = await asr
      .appleStatus(LANGUAGES.map((language) => APPLE_LOCALES[language]))
      .catch(() => null);
    setLanguages(
      Object.fromEntries(
        LANGUAGES.map((language) => [
          language,
          status?.languages.find((entry) => entry.locale === APPLE_LOCALES[language])
            ?.status ?? 'unsupported',
        ]),
      ),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function install(language: AsrLanguage) {
    setError('');
    setInstalling({ language, fraction: 0 });
    try {
      await asr.appleInstall(APPLE_LOCALES[language], (fraction) =>
        setInstalling({ language, fraction }),
      );
    } catch {
      setError(t('recordingSettings.installFailed'));
    } finally {
      setInstalling(null);
      void refresh();
    }
  }

  const state = (id: AsrEngineId) => engines.find((engine) => engine.id === id)?.state;
  const appleReady = state('apple-speech')?.kind === 'ready';
  const mistralReady = state('mistral-api')?.kind === 'ready';
  const hosted = settings.engineId === 'mistral-api';

  return (
    <FieldSection
      title={t('recordingSettings.transcriptionSection')}
      description={t('recordingSettings.transcriptionBody')}
    >
      <FieldRow label={t('recordingSettings.engine')}>
        <GlassSelect
          label={t('recordingSettings.engine')}
          value={settings.engineId}
          onChange={(event) => set({ engineId: event.target.value as AsrEngineId })}
        >
          <option value="apple-speech">{t('recordingSettings.engineApple')}</option>
          {/* Selectable only with a key, so choosing it can never be the
              thing that silently fails at the first transcription. */}
          <option value="mistral-api" disabled={!mistralReady && !hosted}>
            {mistralReady
              ? t('recordingSettings.engineMistral')
              : t('recordingSettings.engineMistralNoKey')}
          </option>
        </GlassSelect>
      </FieldRow>
      <FieldNote tone={hosted ? 'notice' : 'muted'}>
        {t(
          hosted ? 'recordingSettings.privacyMistral' : 'recordingSettings.privacyLocal',
        )}
      </FieldNote>
      {hosted && !mistralReady && (
        <FieldNote tone="danger">
          {t('transcription.error.ASR_API_KEY_MISSING')}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => openSettingsTab('aiProviders')}
          >
            {t('settings.aiProviders')}
          </button>
        </FieldNote>
      )}

      {!hosted &&
        (engines.length && !appleReady ? (
          <FieldNote tone="notice">{t('recordingSettings.unsupportedOs')}</FieldNote>
        ) : (
          <>
            <FieldRow
              label={t('recordingSettings.languagesSection')}
              hint={t('recordingSettings.languagesBody')}
            >
              <ul className="flex flex-col gap-1.5">
                {LANGUAGES.map((language) => {
                  const status = languages[language];
                  const busy = installing?.language === language;
                  return (
                    <li key={language} className="flex items-center gap-3 text-[13px]">
                      <span className="min-w-0 flex-1">
                        {t(
                          `recordingSettings.language${language === 'fr' ? 'Fr' : 'En'}`,
                        )}
                      </span>
                      {busy ? (
                        <span className="flex items-center gap-1.5 text-[12px] text-nb-text-3">
                          <Loader2 size={12} className="animate-spin" aria-hidden />
                          {t('recordingSettings.installing', {
                            percent: Math.round((installing?.fraction ?? 0) * 100),
                          })}
                        </span>
                      ) : status === 'supported' ? (
                        <GlassButton
                          size="sm"
                          disabled={installing !== null}
                          onClick={() => void install(language)}
                        >
                          <Download size={12} aria-hidden />
                          {t('recordingSettings.install')}
                        </GlassButton>
                      ) : (
                        <span className="text-[12px] text-nb-text-3">
                          {t(
                            status === 'installed'
                              ? 'recordingSettings.statusInstalled'
                              : status === 'downloading'
                                ? 'recordingSettings.statusDownloading'
                                : 'recordingSettings.statusUnsupported',
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </FieldRow>
            {error && <FieldNote tone="danger">{error}</FieldNote>}
          </>
        ))}

      <FieldRow
        label={t('recordingSettings.defaultLanguage')}
        hint={t('recordingSettings.defaultLanguageHint')}
      >
        <GlassSelect
          label={t('recordingSettings.defaultLanguage')}
          value={settings.language}
          onChange={(event) =>
            set({
              language: event.target.value as TranscriptionSettingsValue['language'],
            })
          }
        >
          <option value="auto">{t('recordingSettings.languageAuto')}</option>
          <option value="fr">{t('recordingSettings.languageFr')}</option>
          <option value="en">{t('recordingSettings.languageEn')}</option>
        </GlassSelect>
      </FieldRow>
      <FieldRow
        label={t('recordingSettings.useCourseVocabulary')}
        hint={t('recordingSettings.useCourseVocabularyHint')}
        align="end"
      >
        <FieldToggle
          label={t('recordingSettings.useCourseVocabulary')}
          checked={settings.useCourseVocabulary}
          onChange={(useCourseVocabulary) => set({ useCourseVocabulary })}
        />
      </FieldRow>
    </FieldSection>
  );
}
