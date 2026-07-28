/**
 * Settings.
 *
 * A modal rather than a second OS window: everything it changes is visible
 * behind it, and a theme or font-size change you can watch land needs no
 * preview.
 *
 * The nav is grouped rather than flat. Seven equal-weight entries in one column
 * make the reader compare all seven every time; three headed groups — how it
 * looks, what it does with your notes, what it is allowed to talk to — turn the
 * same list into three short ones, and put "Agent access" next to "AI
 * providers" where a reader looking for either would expect to find both.
 */
import {
  Bot,
  DatabaseBackup,
  Info,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Type,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  FieldRow,
  FieldSection,
  FieldToggle,
  GlassButton,
  GlassSegmentedControl,
  GlassSelect,
  ModalOverlay,
} from '@/components/glass';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore, type SettingsTab } from '@/lib/state/uiStore';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils/cn';
import type { AccentColor, AppSettings } from '@/lib/adapters';
import { BackupSettings } from './BackupSettings';
import { AiProviderSettings } from './AiProviderSettings';
import { AgentSettings } from './AgentSettings';
import { AboutSettings } from './AboutSettings';
import { SpeechSettings } from './SpeechSettings';

interface TabEntry {
  id: SettingsTab;
  icon: LucideIcon;
}

/** Nav groups, in the order they appear. The group label is an i18n key. */
const GROUPS: { labelKey: string; tabs: TabEntry[] }[] = [
  {
    labelKey: 'settings.groupApp',
    tabs: [
      { id: 'general', icon: SlidersHorizontal },
      { id: 'appearance', icon: Palette },
      { id: 'editor', icon: Type },
    ],
  },
  {
    labelKey: 'settings.groupContent',
    tabs: [
      { id: 'speech', icon: Volume2 },
      { id: 'backups', icon: DatabaseBackup },
    ],
  },
  {
    labelKey: 'settings.groupConnections',
    tabs: [
      { id: 'aiProviders', icon: Sparkles },
      // The same robot the status bar lights up when an agent is editing.
      { id: 'agent', icon: Bot },
    ],
  },
  { labelKey: 'settings.groupAbout', tabs: [{ id: 'about', icon: Info }] },
];

const EDITOR_FONT_SIZES = { min: 13, max: 22 };
const EDITOR_TITLE_SIZES = { min: 28, max: 52 };
const ACCENTS: { value: AccentColor; color: string }[] = [
  { value: 'orange', color: '#c17a47' },
  { value: 'blue', color: '#3478c7' },
  { value: 'purple', color: '#8b68b8' },
  { value: 'pink', color: '#bc5c7c' },
  { value: 'green', color: '#568b64' },
  { value: 'graphite', color: '#77736d' },
];

export function SettingsWindow() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  const tab = useUiStore((state) => state.settingsTab);
  const setTab = useUiStore((state) => state.setSettingsTab);
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    void update({ [key]: value } as Partial<AppSettings>);
  }

  return (
    <ModalOverlay
      open={open}
      onClose={() => setOpen(false)}
      label={t('settings.title')}
      className="w-[min(760px,94vw)]"
    >
      <div className="flex h-[min(580px,80vh)]">
        <nav
          aria-label={t('settings.title')}
          // Wide enough for "Outils de révision" beside its icon; the FR labels
          // are the ones that decide this number.
          className="flex w-[212px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-[var(--nb-divider)] p-2"
        >
          {GROUPS.map((group) => (
            <div key={group.labelKey}>
              <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-nb-text-3">
                {t(group.labelKey)}
              </h2>
              <div className="flex flex-col gap-0.5">
                {group.tabs.map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    aria-current={tab === id ? 'page' : undefined}
                    className={cn(
                      'flex h-7 items-center gap-2 rounded-nb-xs px-2 text-left text-[13px]',
                      'transition-colors duration-[var(--nb-t-fast)]',
                      tab === id
                        ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                        : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
                    )}
                  >
                    <Icon size={14} className="shrink-0" aria-hidden />
                    <span className="truncate">{t(`settings.${id}`)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto p-4">
            {tab === 'general' && (
              <FieldSection>
                <FieldRow label={t('settings.language')}>
                  <GlassSegmentedControl<Locale>
                    label={t('settings.language')}
                    value={settings.locale}
                    onChange={(locale) => set('locale', locale)}
                    options={SUPPORTED_LOCALES.map((locale) => ({
                      value: locale,
                      label: t(`settings.locale_${locale}`),
                    }))}
                  />
                </FieldRow>
                <FieldRow
                  label={t('settings.checkForUpdates')}
                  hint={t('settings.checkForUpdatesHint')}
                  align="end"
                >
                  <FieldToggle
                    label={t('settings.checkForUpdates')}
                    checked={settings.checkForUpdates}
                    onChange={(checked) => set('checkForUpdates', checked)}
                  />
                </FieldRow>
              </FieldSection>
            )}

            {tab === 'appearance' && (
              <FieldSection>
                <FieldRow label={t('settings.theme')}>
                  <GlassSegmentedControl<AppSettings['theme']>
                    label={t('settings.theme')}
                    value={settings.theme}
                    onChange={(theme) => set('theme', theme)}
                    options={[
                      { value: 'light', label: t('settings.themeLight') },
                      { value: 'dark', label: t('settings.themeDark') },
                      { value: 'system', label: t('settings.themeSystem') },
                    ]}
                  />
                </FieldRow>
                <FieldRow label={t('settings.accentColor')} align="end">
                  <div
                    role="radiogroup"
                    aria-label={t('settings.accentColor')}
                    className="nb-accent-picker"
                  >
                    {ACCENTS.map((accent) => (
                      <button
                        key={accent.value}
                        type="button"
                        role="radio"
                        aria-checked={settings.accentColor === accent.value}
                        aria-label={t(`settings.accent_${accent.value}`)}
                        title={t(`settings.accent_${accent.value}`)}
                        onClick={() => set('accentColor', accent.value)}
                        style={{ '--accent-swatch': accent.color } as React.CSSProperties}
                      >
                        <span />
                      </button>
                    ))}
                  </div>
                </FieldRow>
              </FieldSection>
            )}

            {tab === 'editor' && (
              <div className="space-y-4">
                <FieldSection>
                  <FieldRow label={t('settings.editorFont')}>
                    <GlassSelect
                      label={t('settings.editorFont')}
                      value={settings.editorFont}
                      onChange={(event) =>
                        set('editorFont', event.target.value as AppSettings['editorFont'])
                      }
                    >
                      <option value="sans">{t('settings.fontSans')}</option>
                      <option value="avenir">{t('settings.fontAvenir')}</option>
                      <option value="serif">{t('settings.fontSerif')}</option>
                      <option value="claude">{t('settings.fontClaude')}</option>
                      <option value="iowan">{t('settings.fontIowan')}</option>
                      <option value="mono">{t('settings.fontMono')}</option>
                    </GlassSelect>
                  </FieldRow>
                  <FieldRow label={t('settings.fontSize')} align="end">
                    <SizeSlider
                      label={t('settings.fontSize')}
                      range={EDITOR_FONT_SIZES}
                      value={settings.editorFontSize}
                      onChange={(value) => set('editorFontSize', value)}
                    />
                  </FieldRow>
                  <FieldRow label={t('settings.titleSize')} align="end">
                    <SizeSlider
                      label={t('settings.titleSize')}
                      range={EDITOR_TITLE_SIZES}
                      value={settings.editorTitleSize}
                      onChange={(value) => set('editorTitleSize', value)}
                    />
                  </FieldRow>
                </FieldSection>

                <div
                  className="rounded-nb-sm bg-[var(--nb-inset-surface)] p-3"
                  style={{ fontFamily: 'var(--nb-editor-font)' }}
                >
                  <p
                    className="font-semibold tracking-[-0.03em]"
                    style={{ fontSize: 'var(--nb-editor-title-size)', lineHeight: 1.15 }}
                  >
                    {t('settings.fontPreviewTitle')}
                  </p>
                  <p
                    className="mt-2"
                    style={{
                      fontSize: 'var(--nb-editor-size)',
                      lineHeight: 'var(--nb-editor-leading)',
                    }}
                  >
                    {t('settings.fontPreview')}
                  </p>
                </div>
              </div>
            )}

            {tab === 'backups' && <BackupSettings />}
            {tab === 'speech' && <SpeechSettings />}
            {tab === 'aiProviders' && <AiProviderSettings />}
            {tab === 'agent' && <AgentSettings />}
            {tab === 'about' && <AboutSettings />}
          </div>

          <div className="flex justify-end border-t border-[var(--nb-divider)] p-3">
            <GlassButton size="sm" onClick={() => setOpen(false)}>
              {t('common.close')}
            </GlassButton>
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}

function SizeSlider({
  label,
  range,
  value,
  onChange,
}: {
  label: string;
  range: { min: number; max: number };
  value: number;
  onChange(value: number): void;
}) {
  return (
    <div className="flex w-full items-center gap-2">
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-w-0 flex-1 accent-[var(--nb-accent)]"
      />
      <span className="w-7 shrink-0 text-right text-[12px] tabular-nums text-nb-text-3">
        {value}
      </span>
    </div>
  );
}
