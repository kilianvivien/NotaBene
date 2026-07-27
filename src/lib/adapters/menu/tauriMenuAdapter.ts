import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { MenuAdapter, MenuNode } from './MenuAdapter';

export const tauriMenuAdapter: MenuAdapter = {
  apply: (menu: MenuNode[]) => invoke('menu_apply', { menu }),
  onCommand: (handler) =>
    listen<string>('notabene-menu-command', (event) => handler(event.payload)),
};

/** A browser tab has no menu bar to fill. Every command it would have carried
 * is still bound to its accelerator by `bindCommandKeys`. */
export const unavailableMenuAdapter: MenuAdapter = {
  async apply() {},
  async onCommand() {
    return () => {};
  },
};
