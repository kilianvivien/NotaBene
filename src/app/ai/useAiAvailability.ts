/** Which provider and model a feature would use right now, refreshed against
 * the Keychain — and, for a local runtime, against the runtime itself — on
 * mount, or on becoming `enabled`. Separate from `AiStatusPill` so the pill
 * file exports only a component and fast refresh keeps working. */
import { useEffect } from 'react';
import { isLoopbackUrl, resolveFeature, type AiAvailability, type AiFeature } from '@/lib/ai';
import { useAiStore } from '@/lib/state/aiStore';
import { useSettingsStore } from '@/lib/state/settingsStore';

export function useAiAvailability(feature: AiFeature, enabled = true): AiAvailability {
  const settings = useSettingsStore((state) => state.settings);
  const configured = useAiStore((state) => state.configuredProviderIds);
  const localModels = useAiStore((state) => state.localModels);
  const refreshProviders = useAiStore((state) => state.refreshProviders);
  const refreshLocalModels = useAiStore((state) => state.refreshLocalModels);

  useEffect(() => {
    // A dialog that is mounted but closed must not probe: `DefineDialog` lives
    // inside the editor and is remounted on every note the student opens, and
    // asking Ollama what it has loaded each time is work nobody asked for.
    // Resolving below is pure and cheap, so it always happens — what is gated
    // is only the refresh.
    if (!enabled) return;
    void refreshProviders();
    void refreshLocalModels(settings);
  }, [enabled, refreshProviders, refreshLocalModels, settings]);

  return resolveFeature(feature, settings, configured, localModels);
}

/** Whether the resolved endpoint is on this machine — the claim the "local"
 * badge makes, and the one every caller of it should ask the same way. */
export function isLocalAvailability(availability: AiAvailability): boolean {
  return availability.available && isLoopbackUrl(availability.baseUrl);
}
