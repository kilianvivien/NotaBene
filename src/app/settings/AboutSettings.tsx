/**
 * About.
 *
 * Version, what the app promises, and where its third-party code came from.
 * The privacy line is not marketing copy here — it is the one claim a user
 * cannot verify from the outside, so it says exactly what leaves the machine
 * and under what circumstances, and nothing vaguer than that.
 */
import { useTranslation } from 'react-i18next';
import { FieldSection } from '@/components/glass';

/** Attribution for the dependencies whose licences require it. Kept as data so
 * the release checklist can be diffed against it. */
const CREDITS: { name: string; licence: string }[] = [
  { name: 'TipTap / ProseMirror', licence: 'MIT' },
  { name: 'Excalidraw', licence: 'MIT' },
  { name: 'KaTeX', licence: 'MIT' },
  { name: 'React', licence: 'MIT' },
  { name: 'Tauri', licence: 'Apache-2.0 / MIT' },
  { name: 'SQLite', licence: 'Public domain' },
  { name: 'Lucide', licence: 'ISC' },
  { name: 'Lora', licence: 'SIL Open Font License 1.1' },
];

export function AboutSettings() {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[15px] font-semibold">{t('app.name')}</p>
        <p className="mt-0.5 text-[12px] text-nb-text-3">
          {t('app.version', { version: __APP_VERSION__ })}
        </p>
        <p className="mt-2 max-w-[46ch] text-[13px] leading-snug text-nb-text-2">
          {t('app.tagline')}
        </p>
      </div>

      <FieldSection title={t('settings.aboutPrivacy')}>
        <ul className="space-y-1 text-[12px] leading-snug text-nb-text-2">
          <li>{t('settings.aboutPrivacyLocal')}</li>
          <li>{t('settings.aboutPrivacyNetwork')}</li>
          <li>{t('settings.aboutPrivacyKeys')}</li>
        </ul>
      </FieldSection>

      <FieldSection title={t('settings.aboutLicence')}>
        <p className="text-[12px] leading-snug text-nb-text-2">
          {t('settings.aboutLicenceBody')}
        </p>
      </FieldSection>

      <FieldSection title={t('settings.aboutCredits')}>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
          {CREDITS.map((credit) => (
            <li
              key={credit.name}
              className="flex items-baseline justify-between gap-2 text-[12px]"
            >
              <span className="truncate text-nb-text-2">{credit.name}</span>
              <span className="shrink-0 text-nb-text-3">{credit.licence}</span>
            </li>
          ))}
        </ul>
      </FieldSection>
    </div>
  );
}
