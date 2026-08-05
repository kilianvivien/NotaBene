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
 *
 * Three things about the frame are deliberate:
 *
 * - Every pane gets the same header — the nav entry's own name, and one line
 *   saying what the pane is for. Panes used to introduce themselves or not,
 *   each in their own markup, so switching tabs moved the first line of text
 *   and half the panes had no title at all.
 * - The height follows the content instead of being pinned. A fixed 580px left
 *   Appearance as two rows above 400px of nothing; the nav is the floor now, so
 *   a short pane is a short sheet.
 * - The body is a `GlassScrollArea`, so a pane that is cut off says so with a
 *   fade at the edge rather than slicing a row in half against the footer, and
 *   a new pane starts at its own top.
 */
import {
  Bot,
  DatabaseBackup,
  Info,
  Palette,
  Replace,
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
  GlassScrollArea,
  GlassSegmentedControl,
  GlassSelect,
  ModalOverlay,
} from '@/components/glass';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore, type SettingsTab } from '@/lib/state/uiStore';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils/cn';
import type { AccentColor, AppSettings, FocusSettings } from '@/lib/adapters';
import { EDITOR_FONT_SIZES, EDITOR_MEASURES } from '@/app/shell/readingScale';
import { AbbreviationSettings } from './AbbreviationSettings';
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
      { id: 'abbreviations', icon: Replace },
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

  /** `focus` is a group, so a patch has to carry the fields it is not
   * changing — `update` merges at the top level only. */
  function setFocus(patch: Partial<FocusSettings>): void {
    void update({ focus: { ...settings.focus, ...patch } });
  }

  return (
    <ModalOverlay
      open={open}
      onClose={() => setOpen(false)}
      label={t('settings.title')}
      // `max-w` rather than `w`: the overlay's own 680px cap is in the same
      // Tailwind group, so a plain width was silently clamped and the sheet
      // never reached the size its columns were laid out for.
      className="max-w-[880px]"
    >
      {/* Capped, not fixed. The nav sets the floor, so Appearance is a short
          sheet and Editor a tall one. */}
      <div className="flex max-h-[min(640px,78vh)]">
        <nav
          aria-label={t('settings.title')}
          // Wide enough for "Synthèse vocale" beside its icon; the FR labels
          // are the ones that decide this number.
          className={cn(
            'flex w-[216px] shrink-0 flex-col gap-4 overflow-y-auto p-2.5',
            'border-r border-[var(--nb-divider)] bg-[var(--nb-sidebar-surface)]',
          )}
        >
          {GROUPS.map((group) => (
            <div key={group.labelKey}>
              <h2 className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.07em] text-nb-text-3">
                {t(group.labelKey)}
              </h2>
              <div className="flex flex-col gap-px">
                {group.tabs.map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    aria-current={tab === id ? 'page' : undefined}
                    className={cn(
                      'flex h-8 items-center gap-2.5 rounded-nb-xs px-2.5 text-left text-[13px]',
                      'transition-colors duration-[var(--nb-t-fast)]',
                      tab === id
                        ? 'bg-[var(--nb-accent-soft)] font-medium text-[var(--nb-accent)]'
                        : 'text-nb-text-2 hover:bg-[var(--nb-hover)] hover:text-nb-text',
                    )}
                  >
                    <Icon size={15} className="shrink-0 opacity-90" aria-hidden />
                    <span className="truncate">{t(`settings.${id}`)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-[var(--nb-divider)] px-6 py-3.5">
            <h2 className="text-[15px] font-semibold leading-tight">
              {t(`settings.${tab}`)}
            </h2>
            <p className="mt-1 max-w-[68ch] text-[12px] leading-snug text-nb-text-3">
              {t(`settings.desc_${tab}`)}
            </p>
          </header>

          <GlassScrollArea resetKey={tab} className="px-6 pb-6 pt-5">
            {tab === 'general' && (
              <FieldSection>
                <FieldRow label={t('settings.language')}>
                  <GlassSegmentedControl<Locale>
                    fill
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
                    fill
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
              <div className="space-y-6">
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
                  <FieldRow
                    label={t('settings.editorMeasure')}
                    hint={t('settings.editorMeasureHint')}
                    align="end"
                  >
                    <SizeSlider
                      label={t('settings.editorMeasure')}
                      range={EDITOR_MEASURES}
                      value={settings.editorMeasure}
                      onChange={(value) => set('editorMeasure', value)}
                    />
                  </FieldRow>
                </FieldSection>

                <FieldSection
                  title={t('settings.focusSection')}
                  description={t('settings.focusSectionHint')}
                >
                  <FieldRow label={t('settings.focusAppearance')}>
                    <GlassSegmentedControl<FocusSettings['appearance']>
                      fill
                      label={t('settings.focusAppearance')}
                      value={settings.focus.appearance}
                      onChange={(appearance) => setFocus({ appearance })}
                      options={[
                        { value: 'typewriter', label: t('settings.focusLookTypewriter') },
                        { value: 'app', label: t('settings.focusLookApp') },
                      ]}
                    />
                  </FieldRow>
                  <FieldRow
                    label={t('settings.focusLine')}
                    hint={t('settings.focusLineHint')}
                  >
                    <GlassSegmentedControl<FocusSettings['lineFocus']>
                      fill
                      label={t('settings.focusLine')}
                      value={settings.focus.lineFocus}
                      onChange={(lineFocus) => setFocus({ lineFocus })}
                      options={[
                        { value: 'paragraph', label: t('settings.focusLineParagraph') },
                        { value: 'off', label: t('settings.focusLineOff') },
                      ]}
                    />
                  </FieldRow>
                  <FieldRow
                    label={t('settings.focusTypewriterScroll')}
                    hint={t('settings.focusTypewriterScrollHint')}
                    align="end"
                  >
                    <FieldToggle
                      label={t('settings.focusTypewriterScroll')}
                      checked={settings.focus.typewriterScrolling}
                      onChange={(typewriterScrolling) =>
                        setFocus({ typewriterScrolling })
                      }
                    />
                  </FieldRow>
                  <FieldRow
                    label={t('settings.focusHideChrome')}
                    hint={t('settings.focusHideChromeHint')}
                    align="end"
                  >
                    <FieldToggle
                      label={t('settings.focusHideChrome')}
                      checked={settings.focus.hideChrome}
                      onChange={(hideChrome) => setFocus({ hideChrome })}
                    />
                  </FieldRow>
                  <FieldRow
                    label={t('settings.focusFullscreen')}
                    hint={t('settings.focusFullscreenHint')}
                    align="end"
                  >
                    <FieldToggle
                      label={t('settings.focusFullscreen')}
                      checked={settings.focus.fullscreen}
                      onChange={(fullscreen) => setFocus({ fullscreen })}
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

            {tab === 'abbreviations' && <AbbreviationSettings />}
            {tab === 'backups' && <BackupSettings />}
            {tab === 'speech' && <SpeechSettings />}
            {tab === 'aiProviders' && <AiProviderSettings />}
            {tab === 'agent' && <AgentSettings />}
            {tab === 'about' && <AboutSettings />}
          </GlassScrollArea>

          <div className="flex shrink-0 justify-end border-t border-[var(--nb-divider)] px-6 py-2.5">
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
