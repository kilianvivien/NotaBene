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
  setConcentrationMode,
  type AppCommandId,
} from '@/lib/commands';
import { isOverlayOpen, useUiStore } from '@/lib/state/uiStore';
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

  useFocusModeEscape();
}

/** Transient surfaces that own Escape while they are on screen. They are not
 * store state — the slash and wiki-link menus live in the editor's local state,
 * the find bar in the editor's — so the DOM is where to ask. */
const ESCAPE_HOLDERS = '.nb-slash-menu, .nb-find-replace, [role="menu"]';

/**
 * Escape leaves concentration mode.
 *
 * A mode that fills the window needs the key everyone already tries, but Escape
 * is the most contested key in the app. `defaultPrevented` is no help here:
 * ProseMirror marks Escape handled whenever the editor has focus, which is
 * precisely when someone would press it to get out. So the claim is made
 * positively instead — nothing modal open, no transient menu on screen, and
 * focus either in the note or nowhere in particular. A dialog, the command
 * palette, the find bar and the title bar's search field all hold focus while
 * they are open, so each of them keeps the key.
 */
function useFocusModeEscape(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const ui = useUiStore.getState();
      if (!ui.focusMode || isOverlayOpen(ui)) return;
      if (document.querySelector(ESCAPE_HOLDERS)) return;

      const active = document.activeElement;
      const inEditor = active?.closest('.nb-editor-scroll') != null;
      if (active && active !== document.body && !inEditor) return;

      event.preventDefault();
      void setConcentrationMode(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
