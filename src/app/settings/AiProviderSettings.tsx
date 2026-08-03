/**
 * AI providers.
 *
 * Two panes of one idea: which providers you have connected, and which model
 * each feature should use. Everything here is optional — the app works with no
 * provider at all, and every AI affordance elsewhere says "connect a provider"
 * rather than failing.
 *
 * The list is an accordion, not eight stacked cards. A student uses one
 * provider, occasionally two; laying all eight out with a key field, a Save and
 * a Test each made a pane you had to scroll past seven irrelevant boxes to
 * reach the eighth. Collapsed, a row states the only thing that matters from
 * outside — connected or not — and expanding is the gesture that says "this is
 * the one I care about".
 *
 * The key field is write-only. A stored key is never read back into the
 * webview; the pane learns that a provider is configured from
 * `SecretsAdapter.listKeys`, which returns names. A settings screen that can
 * display your key is a settings screen that can leak it into a screenshot.
 */
import { Check, ChevronRight, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FieldSection, GlassButton, GlassSelect } from '@/components/glass';
import { secrets } from '@/lib/adapters';
import type { AppSettings } from '@/lib/adapters';
import {
  AI_FEATURES,
  AI_PROVIDERS,
  baseUrlFor,
  isProviderUsable,
  loadProvider,
  modelsFor,
  resolveFeature,
  runAi,
  secretKeyFor,
  type AiFeature,
  type ProviderDefinition,
} from '@/lib/ai';
import { useAiStore } from '@/lib/state/aiStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { cn } from '@/lib/utils/cn';

export function AiProviderSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const configured = useAiStore((state) => state.configuredProviderIds);
  const refreshProviders = useAiStore((state) => state.refreshProviders);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const connectedCount = AI_PROVIDERS.filter((definition) =>
    isProviderUsable(definition, settings, configured),
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <FieldSection
        title={t('ai.providersSection')}
        description={
          connectedCount
            ? t('ai.connectedCount', { count: connectedCount })
            : t('ai.noneConnected')
        }
      >
        <ul className="divide-y divide-[var(--nb-divider)] overflow-hidden rounded-nb-sm border border-[var(--nb-divider)]">
          {AI_PROVIDERS.map((definition) => (
            <ProviderRow
              key={definition.id}
              definition={definition}
              connected={configured.includes(definition.id)}
              open={expanded === definition.id}
              onToggle={() =>
                setExpanded((current) =>
                  current === definition.id ? null : definition.id,
                )
              }
            />
          ))}
        </ul>
      </FieldSection>

      <FieldSection title={t('ai.featureModels')} description={t('ai.featureModelsHint')}>
        <div className="flex flex-col gap-1.5">
          {AI_FEATURES.map((feature) => (
            <FeatureRow key={feature} feature={feature} settings={settings} />
          ))}
        </div>
      </FieldSection>
    </div>
  );
}

function ProviderRow({
  definition,
  connected,
  open,
  onToggle,
}: {
  definition: ProviderDefinition;
  connected: boolean;
  open: boolean;
  onToggle(): void;
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const refreshProviders = useAiStore((state) => state.refreshProviders);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const config = settings.aiProviders[definition.id];
  const baseUrl = config?.baseUrl ?? '';
  const enabled = config?.enabled === true;

  function patchProvider(patch: Partial<AppSettings['aiProviders'][string]>) {
    void update({
      aiProviders: {
        ...settings.aiProviders,
        [definition.id]: {
          enabled: config?.enabled,
          baseUrl: config?.baseUrl ?? null,
          extraModels: config?.extraModels ?? [],
          ...patch,
        },
      },
    });
  }

  async function saveKey() {
    const value = key.trim();
    if (!value) return;
    setBusy(true);
    await secrets.set(secretKeyFor(definition.id), value);
    // Clear it out of React state the moment it is stored: there is no reason
    // for the key to sit in a component's memory after the write.
    setKey('');
    await refreshProviders();
    setBusy(false);
    setStatus(t('ai.keySaved'));
  }

  async function removeKey() {
    setBusy(true);
    await secrets.remove(secretKeyFor(definition.id));
    await refreshProviders();
    setBusy(false);
    setStatus('');
  }

  /** A round trip with a two-word prompt. Cheaper than any diagnostic the user
   * could run themselves, and it answers the only question they have. */
  async function test() {
    setBusy(true);
    setStatus(t('ai.testing'));
    const model =
      settings.aiFeatureModels[definition.id]?.model ||
      definition.defaultModel ||
      modelsFor(definition, settings)[0] ||
      '';
    try {
      const provider = await loadProvider({
        available: true,
        definition,
        baseUrl: baseUrlFor(definition, settings),
        model,
      });
      await runAi(
        {
          provider,
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
          maxTokens: 16,
          temperature: 0,
          json: false,
          stream: false,
        },
        { timeoutMs: 30_000 },
      );
      setStatus(t('ai.testOk'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
    setBusy(false);
  }

  const usable = definition.requiresKey ? connected : enabled;

  return (
    <li className={cn(open && 'bg-[var(--nb-inset-surface)]')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--nb-hover)]"
      >
        <ChevronRight
          size={13}
          aria-hidden
          className={cn(
            'shrink-0 text-nb-text-3 transition-transform duration-[var(--nb-t-fast)]',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">{definition.label}</span>
        {usable ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--nb-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--nb-accent)]">
            <Check size={9} aria-hidden />
            {t('ai.connected')}
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-nb-text-3">
            {definition.requiresKey ? t('ai.needsKey') : t('ai.notEnabled')}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--nb-divider)] px-3 py-2.5">
          {definition.requiresKey ? (
            <div className="flex gap-1.5">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                placeholder={connected ? t('ai.keyStored') : t('ai.keyPlaceholder')}
                onChange={(event) => setKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveKey();
                }}
                aria-label={t('ai.apiKey', { provider: definition.label })}
                className="h-8 min-w-0 flex-1 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
              />
              <GlassButton
                size="sm"
                disabled={!key.trim() || busy}
                onClick={() => void saveKey()}
              >
                {t('ai.saveKey')}
              </GlassButton>
              {connected && (
                <GlassButton
                  size="sm"
                  variant="ghost"
                  aria-label={t('ai.removeKey')}
                  disabled={busy}
                  onClick={() => void removeKey()}
                >
                  <Trash2 size={12} />
                </GlassButton>
              )}
            </div>
          ) : (
            <label className="flex items-center gap-2 text-[12px] text-nb-text-2">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => patchProvider({ enabled: event.target.checked })}
                className="size-4 accent-[var(--nb-accent)]"
              />
              {t('ai.enableLocal')}
            </label>
          )}

          {definition.editableBaseUrl && (
            <label className="block text-[11px] text-nb-text-3">
              {t('ai.baseUrl')}
              <input
                type="url"
                value={baseUrl}
                spellCheck={false}
                placeholder={definition.defaultBaseUrl || 'https://…/v1'}
                onChange={(event) =>
                  patchProvider({ baseUrl: event.target.value || null })
                }
                className="mt-1 h-8 w-full rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px] text-nb-text"
              />
            </label>
          )}

          <div className="flex items-center gap-2">
            <GlassButton
              size="sm"
              variant="ghost"
              disabled={!usable || busy}
              onClick={() => void test()}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              {t('ai.testConnection')}
            </GlassButton>
            {definition.keyUrl && (
              <a
                href={definition.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-[11px] text-nb-text-3 hover:text-nb-text-2"
              >
                {t('ai.getKey')}
                <ExternalLink size={10} aria-hidden />
              </a>
            )}
            {status && (
              <span className="min-w-0 flex-1 truncate text-right text-[11px] text-nb-text-3">
                {status}
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function FeatureRow({ feature, settings }: { feature: AiFeature; settings: AppSettings }) {
  const { t } = useTranslation();
  const update = useSettingsStore((state) => state.update);
  const configured = useAiStore((state) => state.configuredProviderIds);
  const resolved = resolveFeature(feature, settings, configured);

  const choice = settings.aiFeatureModels[feature];
  const definition = resolved.available ? resolved.definition : null;
  const model = resolved.available ? resolved.model : '';

  function choose(providerId: string, nextModel: string) {
    const target = AI_PROVIDERS.find((provider) => provider.id === providerId);
    const catalogue = target ? target.models : [];
    const previous = settings.aiProviders[providerId];
    const extraModels =
      nextModel && !catalogue.includes(nextModel)
        ? [...new Set([...(previous?.extraModels ?? []), nextModel])]
        : (previous?.extraModels ?? []);

    void update({
      aiFeatureModels: {
        ...settings.aiFeatureModels,
        [feature]: { providerId, model: nextModel },
      },
      aiProviders: {
        ...settings.aiProviders,
        [providerId]: {
          enabled: previous?.enabled,
          baseUrl: previous?.baseUrl ?? null,
          extraModels,
        },
      },
    });
  }

  const listId = `nb-models-${feature}`;
  // The suggestion list follows whichever provider the row is *pointing at* —
  // the one explicitly chosen, or the one resolution fell through to.
  const listed = choice?.providerId
    ? AI_PROVIDERS.find((provider) => provider.id === choice.providerId)
    : definition;

  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
      <span className="truncate text-[12px]" title={t(`ai.feature_${feature}`)}>
        {t(`ai.feature_${feature}`)}
      </span>
      <GlassSelect
        label={t(`ai.feature_${feature}`)}
        size="sm"
        value={choice?.providerId ?? definition?.id ?? ''}
        onChange={(event) => choose(event.target.value, '')}
      >
        <option value="">{t('ai.useDefault')}</option>
        {AI_PROVIDERS.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.label}
          </option>
        ))}
      </GlassSelect>
      <input
        list={listId}
        spellCheck={false}
        aria-label={t('ai.model')}
        value={choice?.model ?? ''}
        placeholder={model || t('ai.modelPlaceholder')}
        onChange={(event) =>
          choose(choice?.providerId ?? definition?.id ?? '', event.target.value)
        }
        disabled={!choice?.providerId && !definition}
        className={cn(
          'h-7 min-w-0 rounded-nb-xs border border-[var(--nb-control-border)]',
          'bg-[var(--nb-control-surface)] px-2 text-[12px] disabled:opacity-40',
        )}
      />
      <datalist id={listId}>
        {listed
          ? modelsFor(listed, settings).map((entry) => <option key={entry} value={entry} />)
          : null}
      </datalist>
    </div>
  );
}
