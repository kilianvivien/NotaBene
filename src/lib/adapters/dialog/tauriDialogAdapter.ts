import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import type { DialogAdapter } from './DialogAdapter';

/**
 * Every panel opens from Rust (`src-tauri/src/grants.rs`), which records what
 * the student chose. Commands that write, read or move files outside
 * NotaBene's own folders accept only a recorded path, so a path this adapter
 * returns is the only kind that works — and one the webview made up is not.
 */
export const tauriDialogAdapter: DialogAdapter = {
  async openFile(options) {
    return invoke<string[]>('dialog_pick_files', {
      filters: options?.filters ?? [],
      multiple: options?.multiple ?? false,
    });
  },

  async openFolder(options) {
    return invoke<string | null>('dialog_pick_folder', {
      purpose: options?.purpose ?? null,
    });
  },

  async readFile(path) {
    return new Blob([await readFile(path)]);
  },

  saveFile: (options) =>
    invoke<string | null>('dialog_pick_save', {
      defaultPath: options?.defaultPath ?? null,
      filters: options?.filters ?? [],
    }),

  confirm: (message, options) =>
    confirm(message, {
      title: options?.title,
      kind: options?.danger ? 'warning' : 'info',
    }),
};
