/**
 * Settings.
 *
 * A modal rather than a second OS window: everything it changes is visible
 * behind it, and a theme or font-size change you can watch land needs no
 * preview. Sections that have not landed yet remain listed with their phase
 * rather than hidden, so the shape of the app is honest about what is coming.
 */
import {
  Bot,
  DatabaseBackup,
  Info,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassButton, GlassSegmentedControl, ModalOverlay } from '@/components/glass';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore, type SettingsTab } from '@/lib/state/uiStore';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils/cn';
import type { AccentColor, AppSettings } from '@/lib/adapters';
import { BackupSettings } from './BackupSettings';
import { AiProviderSettings } from './AiProviderSettings';
import { AgentSettings } from './AgentSettings';

/** Sections, their icons, and (for placeholders) the phase that makes each real. */
const TABS: { id: SettingsTab; icon: LucideIcon; landsIn?: string }[] = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'appearance', icon: Palette },
  { id: 'editor', icon: Type },
  { id: 'aiProviders', icon: Sparkles },
  { id: 'backups', icon: DatabaseBackup },
  // The same robot the status bar lights up when an agent is editing.
  { id: 'agent', icon: Bot },
  { id: 'about', icon: Info, landsIn: 'H' },
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
    <ModalOverlay open={open} onClose={() => setOpen(false)} label={t('settings.title')}>
      <div className="flex h-[min(560px,78vh)]">
        <nav
          aria-label={t('settings.title')}
          // Wide enough for "Fournisseurs IA" beside its phase badge; the FR
          // labels are the ones that decide this number.
          className="flex w-[196px] shrink-0 flex-col gap-0.5 border-r border-[var(--nb-divider)] p-2"
        >
          {TABS.map(({ id, icon: Icon, landsIn }) => (
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
              {landsIn && (
                <span className="ml-auto shrink-0 text-[10px] text-nb-text-3">
                  {t('settings.phaseBadge', { phase: landsIn })}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto p-4">
            {tab === 'general' && (
              <Section>
                <Row label={t('settings.language')}>
                  <GlassSegmentedControl<Locale>
                    label={t('settings.language')}
                    value={settings.locale}
                    onChange={(locale) => set('locale', locale)}
                    options={SUPPORTED_LOCALES.map((locale) => ({
                      value: locale,
                      label: t(`settings.locale_${locale}`),
                    }))}
                  />
                </Row>
                <Row
                  label={t('settings.checkForUpdates')}
                  hint={t('settings.checkForUpdatesHint')}
                >
                  <Toggle
                    label={t('settings.checkForUpdates')}
                    checked={settings.checkForUpdates}
                    onChange={(checked) => set('checkForUpdates', checked)}
                  />
                </Row>
              </Section>
            )}

            {tab === 'appearance' && (
              <Section>
                <Row label={t('settings.theme')}>
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
                </Row>
                <Row label={t('settings.accentColor')}>
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
                </Row>
              </Section>
            )}

            {tab === 'editor' && (
              <Section>
                <Row label={t('settings.editorFont')}>
                  <select
                    aria-label={t('settings.editorFont')}
                    value={settings.editorFont}
                    onChange={(event) =>
                      set('editorFont', event.target.value as AppSettings['editorFont'])
                    }
                    className="h-8 min-w-40 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--nb-accent-ring)]"
                  >
                    <option value="sans">{t('settings.fontSans')}</option>
                    <option value="avenir">{t('settings.fontAvenir')}</option>
                    <option value="serif">{t('settings.fontSerif')}</option>
                    <option value="claude">{t('settings.fontClaude')}</option>
                    <option value="iowan">{t('settings.fontIowan')}</option>
                    <option value="mono">{t('settings.fontMono')}</option>
                  </select>
                </Row>
                <Row label={t('settings.fontSize')}>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={EDITOR_FONT_SIZES.min}
                      max={EDITOR_FONT_SIZES.max}
                      step={1}
                      value={settings.editorFontSize}
                      aria-label={t('settings.fontSize')}
                      onChange={(event) =>
                        set('editorFontSize', Number(event.target.value))
                      }
                      className="w-[140px] accent-[var(--nb-accent)]"
                    />
                    <span className="w-8 text-right text-[12px] tabular-nums text-nb-text-3">
                      {settings.editorFontSize}
                    </span>
                  </div>
                </Row>
                <Row label={t('settings.titleSize')}>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={EDITOR_TITLE_SIZES.min}
                      max={EDITOR_TITLE_SIZES.max}
                      step={1}
                      value={settings.editorTitleSize}
                      aria-label={t('settings.titleSize')}
                      onChange={(event) =>
                        set('editorTitleSize', Number(event.target.value))
                      }
                      className="w-[140px] accent-[var(--nb-accent)]"
                    />
                    <span className="w-8 text-right text-[12px] tabular-nums text-nb-text-3">
                      {settings.editorTitleSize}
                    </span>
                  </div>
                </Row>
                <div
                  className="rounded-nb-sm bg-[var(--nb-hover)] p-3"
                  style={{
                    fontFamily: 'var(--nb-editor-font)',
                  }}
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
              </Section>
            )}

            {tab === 'backups' && <BackupSettings />}

            {tab === 'aiProviders' && <AiProviderSettings />}

            {tab === 'agent' && <AgentSettings />}

            {tab === 'about' && (
              <p className="text-[13px] text-nb-text-3">
                {t('settings.landsInPhase', {
                  phase: TABS.find((entry) => entry.id === tab)?.landsIn ?? '—',
                })}
              </p>
            )}
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

function Section({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px]">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] text-nb-text-3">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[22px] w-[38px] rounded-full transition-colors duration-[var(--nb-t-fast)]',
        checked ? 'bg-[var(--nb-accent)]' : 'bg-[var(--nb-active)]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-[2px] size-[18px] rounded-full bg-white shadow-sm',
          'transition-[left] duration-[var(--nb-t-fast)]',
          checked ? 'left-[18px]' : 'left-[2px]',
        )}
      />
    </button>
  );
}
