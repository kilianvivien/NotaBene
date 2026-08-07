/**
 * About.
 *
 * Version, what the app promises, and where its third-party code came from.
 * The privacy lines are not marketing copy here — they are the one claim a user
 * cannot verify from the outside, so they say exactly what leaves the machine
 * and under what circumstances, and nothing vaguer than that. They are given a
 * glyph and a row each because three long sentences in an unmarked list read as
 * a paragraph nobody finishes; the wording itself is unchanged.
 */
import { HardDrive, KeyRound, Wifi } from 'lucide-react';
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

/** One promise, one glyph: where the data sits, what may leave, where the keys
 * are. In that order, because it is the order of the questions. */
const PROMISES = [
  { key: 'aboutPrivacyLocal', icon: HardDrive },
  { key: 'aboutPrivacyNetwork', icon: Wifi },
  { key: 'aboutPrivacyKeys', icon: KeyRound },
] as const;

/**
 * What the AI features are, in the order someone finds out: there is no AI
 * here, what you get from one can be wrong, where it lands in your note, and
 * whose call it is to keep it. This is the page the "i" beside every model name
 * opens, which is why the sentences are written to be read cold.
 */
const AI_NOTICE = [
  'aboutAiWhat',
  'aboutAiGenerated',
  'aboutAiTrace',
  'aboutAiResponsibility',
] as const;

export function AboutSettings() {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3.5">
        {/* The app's own icon, from `public/` — the same file the window and the
            web manifest use, so it cannot drift from what is in the Dock. */}
        <img
          src="/icon-192.png"
          alt=""
          width={192}
          height={192}
          className="size-14 shrink-0"
        />
        <div className="min-w-0">
          <p className="text-[17px] font-semibold tracking-[-0.01em]">{t('app.name')}</p>
          <p className="mt-0.5 max-w-[46ch] text-[12.5px] leading-snug text-nb-text-2">
            {t('app.tagline')}
          </p>
          <p className="mt-1 text-[11px] tabular-nums text-nb-text-3">
            {t('app.version', { version: __APP_VERSION__ })} ·{' '}
            {t('settings.aboutLicenceBody')}
          </p>
        </div>
      </div>

      <FieldSection title={t('settings.aboutPrivacy')}>
        <ul className="divide-y divide-[var(--nb-divider)] overflow-hidden rounded-nb-sm bg-[var(--nb-inset-surface)]">
          {PROMISES.map(({ key, icon: Icon }) => (
            <li key={key} className="flex items-start gap-2.5 px-3 py-2.5">
              <Icon size={14} className="mt-px shrink-0 text-nb-text-3" aria-hidden />
              <span className="text-[12px] leading-snug text-nb-text-2">
                {t(`settings.${key}`)}
              </span>
            </li>
          ))}
        </ul>
      </FieldSection>

      <FieldSection title={t('settings.aboutAi')} description={t('settings.aboutAiLaw')}>
        <ul className="space-y-1.5">
          {AI_NOTICE.map((key) => (
            <li
              key={key}
              className="border-l-2 border-[var(--nb-divider-strong)] pl-2.5 text-[12px] leading-snug text-nb-text-2"
            >
              {t(`settings.${key}`)}
            </li>
          ))}
        </ul>
      </FieldSection>

      <FieldSection title={t('settings.aboutCredits')}>
        <ul className="grid grid-cols-2 gap-x-5">
          {CREDITS.map((credit) => (
            <li
              key={credit.name}
              className="flex items-baseline justify-between gap-2 border-b border-[var(--nb-divider)] py-1.5 text-[12px] last:border-0 [&:nth-last-child(2)]:border-0"
            >
              <span className="truncate text-nb-text-2">{credit.name}</span>
              <span className="shrink-0 text-[11px] text-nb-text-3">
                {credit.licence}
              </span>
            </li>
          ))}
        </ul>
      </FieldSection>
    </div>
  );
}
