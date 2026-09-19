import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appleFm, DEFAULT_SETTINGS, type AppSettings } from '@/lib/adapters';
import { configuredPort, useAppleFmStore } from './appleFmStore';
import { useSettingsStore } from './settingsStore';

function settingsWithApple(
  enabled: boolean,
  baseUrl: string | null = null,
): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    aiProviders: {
      apple: { enabled, baseUrl, extraModels: [] },
    },
  };
}

beforeEach(() => {
  useSettingsStore.setState({ settings: settingsWithApple(false), loaded: true });
  useAppleFmStore.setState({
    preflight: null,
    status: { running: false, port: null, managed: false, error: null },
    pending: false,
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('configuredPort', () => {
  it('keeps only a saved loopback port', () => {
    expect(configuredPort(settingsWithApple(true, 'http://127.0.0.1:43121/v1'))).toBe(
      43121,
    );
    expect(configuredPort(settingsWithApple(true, 'https://example.com:43121/v1'))).toBe(
      undefined,
    );
    expect(configuredPort(settingsWithApple(true))).toBeUndefined();
  });
});

describe('managed Apple model lifecycle', () => {
  it('does not probe or start the service at launch when Apple is disabled', async () => {
    const preflight = vi.spyOn(appleFm, 'preflight');
    const status = vi.spyOn(appleFm, 'status');
    const start = vi.spyOn(appleFm, 'start');

    await useAppleFmStore.getState().initialize();

    expect(preflight).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('restores an enabled service at launch', async () => {
    useSettingsStore.setState({ settings: settingsWithApple(true), loaded: true });
    vi.spyOn(appleFm, 'status').mockResolvedValue({
      running: true,
      port: 43121,
      managed: true,
      error: null,
    });
    const start = vi.spyOn(appleFm, 'start');

    await useAppleFmStore.getState().initialize();

    expect(start).not.toHaveBeenCalled();
    expect(useAppleFmStore.getState().status.running).toBe(true);
  });

  it('starts on opt-in and stores the selected port as the provider URL', async () => {
    vi.spyOn(appleFm, 'status')
      .mockResolvedValueOnce({ running: false, port: null, managed: false, error: null })
      .mockResolvedValueOnce({ running: true, port: 43121, managed: true, error: null });
    vi.spyOn(appleFm, 'preflight').mockResolvedValue({
      installed: true,
      osOk: true,
      licensed: true,
      model: 'available',
      detail: 'System model available',
    });
    const start = vi.spyOn(appleFm, 'start').mockResolvedValue(43121);

    await useAppleFmStore.getState().setEnabled(true);

    expect(start).toHaveBeenCalledWith(undefined);
    expect(useSettingsStore.getState().settings.aiProviders.apple).toMatchObject({
      enabled: true,
      baseUrl: 'http://127.0.0.1:43121/v1',
    });
    expect(useAppleFmStore.getState().status.running).toBe(true);
  });

  it('keeps the opt-in and a named preflight state when licensing is missing', async () => {
    vi.spyOn(appleFm, 'status').mockResolvedValue({
      running: false,
      port: null,
      managed: false,
      error: null,
    });
    vi.spyOn(appleFm, 'preflight').mockResolvedValue({
      installed: true,
      osOk: true,
      licensed: false,
      model: 'unknown',
      detail: 'license required',
    });
    const start = vi.spyOn(appleFm, 'start');

    await useAppleFmStore.getState().setEnabled(true);

    expect(start).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.aiProviders.apple?.enabled).toBe(true);
    expect(useAppleFmStore.getState().error).toBe('apple_fm_not_licensed');
  });

  it('does not start a second server when the saved one is healthy', async () => {
    vi.spyOn(appleFm, 'status').mockResolvedValue({
      running: true,
      port: 43121,
      managed: true,
      error: null,
    });
    const start = vi.spyOn(appleFm, 'start');

    await useAppleFmStore.getState().ensureRunning();

    expect(start).not.toHaveBeenCalled();
    expect(useAppleFmStore.getState().status.port).toBe(43121);
  });

  it('stops the child when the provider is disabled', async () => {
    useSettingsStore.setState({ settings: settingsWithApple(true), loaded: true });
    const stop = vi.spyOn(appleFm, 'stop').mockResolvedValue();

    await useAppleFmStore.getState().setEnabled(false);

    expect(stop).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().settings.aiProviders.apple?.enabled).toBe(false);
    expect(useAppleFmStore.getState().status.running).toBe(false);
  });
});
