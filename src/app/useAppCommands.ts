/**
 * Wire the command table to whichever shell is running.
 *
 * Under Tauri the native menu owns the accelerators, so binding them to the
 * window as well would run every command twice. In a browser tab there is no
 * menu bar, so the keyboard is the only route and the bindings are installed
 * instead. Either way the command that runs is the same function.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { appMenu } from '@/lib/adapters';
import { platformRuntime } from '@/lib/platform/runtime';
import {
  APP_COMMANDS,
  bindCommandKeys,
  runAppCommand,
  setCommandTranslator,
  type AppCommandId,
} from '@/lib/commands';
import { buildMenuBar } from './menuBar';

function isAppCommandId(value: string): value is AppCommandId {
  return value in APP_COMMANDS;
}

export function useAppCommands(): void {
  const { t, i18n } = useTranslation();
  const nativeMenus = platformRuntime.capabilities.nativeMenus;

  // Commands raise user-facing strings of their own (a new course's name, the
  // menu labels); this is how they reach the same translations the UI uses.
  useEffect(() => {
    setCommandTranslator((key) => t(key));
  }, [t]);

  useEffect(() => {
    if (!nativeMenus) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const stop = await appMenu.onCommand((commandId) => {
        if (isAppCommandId(commandId)) void runAppCommand(commandId);
      });
      // A locale change or a fast unmount can beat the subscription home.
      if (disposed) stop();
      else unlisten = stop;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeMenus]);

  // Rebuilt on every language change: the labels are baked into the NSMenu,
  // so switching to French has to hand the shell a new description.
  useEffect(() => {
    if (!nativeMenus) return;
    void appMenu.apply(buildMenuBar((key) => t(key)));
  }, [nativeMenus, t, i18n.language]);

  useEffect(() => {
    if (nativeMenus) return;
    return bindCommandKeys();
  }, [nativeMenus]);
}
