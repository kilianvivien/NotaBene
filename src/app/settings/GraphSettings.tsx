import { useTranslation } from 'react-i18next';
import {
  FieldRow,
  FieldSection,
  FieldToggle,
  GlassButton,
  GlassSelect,
} from '@/components/glass';
import {
  DEFAULT_SETTINGS,
  GRAPH_LIMITS,
  type GraphSettings as GraphPreferences,
} from '@/lib/adapters';
import { useSettingsStore } from '@/lib/state/settingsStore';

const OUTPUT_ALLOWANCES = [8_192, 16_384, 32_768, 65_536];
const SLIDERS = ['maxNotes', 'excerptChars', 'maxSuggestions'] as const;

export function GraphSettings() {
  const { t, i18n } = useTranslation();
  const preferences = useSettingsStore((state) => state.settings.graph);
  const update = useSettingsStore((state) => state.update);
  const number = (value: number) => value.toLocaleString(i18n.language);

  function set<K extends keyof GraphPreferences>(key: K, value: GraphPreferences[K]) {
    void update({
      graph: { ...useSettingsStore.getState().settings.graph, [key]: value },
    });
  }

  return (
    <div className="space-y-6">
      <FieldSection
        title={t('settings.graphView')}
        description={t('settings.graphViewHint')}
      >
        <FieldRow
          label={t('settings.graphShowMentions')}
          hint={t('settings.graphShowMentionsHint')}
          align="end"
        >
          <FieldToggle
            label={t('settings.graphShowMentions')}
            checked={preferences.showMentions}
            onChange={(value) => set('showMentions', value)}
          />
        </FieldRow>
        <FieldRow
          label={t('settings.graphLinkedOnly')}
          hint={t('settings.graphLinkedOnlyHint')}
          align="end"
        >
          <FieldToggle
            label={t('settings.graphLinkedOnly')}
            checked={preferences.linkedOnly}
            onChange={(value) => set('linkedOnly', value)}
          />
        </FieldRow>
      </FieldSection>

      <FieldSection title={t('settings.graphAi')} description={t('settings.graphAiHint')}>
        <FieldRow
          label={t('settings.graphMaxOutputTokens')}
          hint={t('settings.graphMaxOutputTokensHint')}
        >
          <GlassSelect
            label={t('settings.graphMaxOutputTokens')}
            value={preferences.maxOutputTokens}
            onChange={(event) => set('maxOutputTokens', Number(event.target.value))}
          >
            {!OUTPUT_ALLOWANCES.includes(preferences.maxOutputTokens) && (
              <option value={preferences.maxOutputTokens}>
                {number(preferences.maxOutputTokens)}
              </option>
            )}
            {OUTPUT_ALLOWANCES.map((value) => (
              <option key={value} value={value}>
                {number(value)}
              </option>
            ))}
          </GlassSelect>
        </FieldRow>
        {SLIDERS.map((key) => (
          <FieldRow
            key={key}
            label={t(`settings.graphLimits.${key}`)}
            hint={t(`settings.graphLimits.${key}Hint`)}
          >
            <div className="flex w-full items-center gap-3">
              <input
                type="range"
                min={GRAPH_LIMITS[key].min}
                max={GRAPH_LIMITS[key].max}
                step={1}
                value={preferences[key]}
                aria-label={t(`settings.graphLimits.${key}`)}
                onChange={(event) => set(key, Number(event.target.value))}
                className="min-w-0 flex-1 accent-[var(--nb-accent)]"
              />
              <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-nb-text-3">
                {number(preferences[key])}
              </span>
            </div>
          </FieldRow>
        ))}
      </FieldSection>
      <GlassButton
        size="sm"
        variant="ghost"
        onClick={() => void update({ graph: { ...DEFAULT_SETTINGS.graph } })}
      >
        {t('settings.graphReset')}
      </GlassButton>
    </div>
  );
}
