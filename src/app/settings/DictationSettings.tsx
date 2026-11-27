/**
 * Settings → Recording → Dictation.
 *
 * Direct dictation has nothing to tune: the model is pinned and the gesture
 * is fixed. The section exists because the gesture is otherwise
 * undiscoverable (a five-second hold on the microphone) and because the
 * privacy line belongs beside the local transcription it differs from. It
 * says how to start dictation, that the audio goes to Mistral, and whether a
 * key is there, the same way `dictationCommands` will check it.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FieldNote, FieldSection } from '@/components/glass';
import { dictation, secrets } from '@/lib/adapters';
import { secretKeyFor } from '@/lib/ai/providers';
import { useUiStore } from '@/lib/state/uiStore';

export function DictationSettings() {
  const { t } = useTranslation();
  const openSettingsTab = useUiStore((state) => state.setSettingsTab);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const supported = dictation.supported();

  useEffect(() => {
    let live = true;
    void secrets
      .get(secretKeyFor('mistral'))
      .then((key) => live && setHasKey(Boolean(key)))
      .catch(() => live && setHasKey(false));
    return () => {
      live = false;
    };
  }, []);

  return (
    <FieldSection
      anchor="recordingDictation"
      title={t('recordingSettings.dictationSection')}
      description={t('recordingSettings.dictationBody')}
    >
      {!supported ? (
        <FieldNote tone="notice">{t('dictation.unsupported')}</FieldNote>
      ) : (
        <>
          <FieldNote tone="notice">{t('recordingSettings.dictationPrivacy')}</FieldNote>
          {hasKey === false && (
            <FieldNote tone="danger">
              {t('dictation.keyMissing')}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => openSettingsTab('aiProviders')}
              >
                {t('settings.aiProviders')}
              </button>
            </FieldNote>
          )}
        </>
      )}
    </FieldSection>
  );
}
