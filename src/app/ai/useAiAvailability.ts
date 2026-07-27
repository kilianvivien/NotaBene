/** Which provider and model a feature would use right now, refreshed against
 * the Keychain on mount. Separate from `AiStatusPill` so the pill file exports
 * only a component and fast refresh keeps working. */
import { useEffect } from 'react';
import { resolveFeature, type AiAvailability, type AiFeature } from '@/lib/ai';
import { useAiStore } from '@/lib/state/aiStore';
import { useSettingsStore } from '@/lib/state/settingsStore';

export function useAiAvailability(feature: AiFeature): AiAvailability {
  const settings = useSettingsStore((state) => state.settings);
  const configured = useAiStore((state) => state.configuredProviderIds);
  const refreshProviders = useAiStore((state) => state.refreshProviders);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  return resolveFeature(feature, settings, configured);
}
