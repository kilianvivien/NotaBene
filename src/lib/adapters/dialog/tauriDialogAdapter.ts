import { confirm, open, save } from '@tauri-apps/plugin-dialog';
import type { DialogAdapter } from './DialogAdapter';

export const tauriDialogAdapter: DialogAdapter = {
  async openFile(options) {
    const picked = await open({
      multiple: options?.multiple ?? false,
      filters: options?.filters,
    });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  },

  async openFolder() {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === 'string' ? picked : null;
  },

  saveFile: (options) =>
    save({ defaultPath: options?.defaultPath, filters: options?.filters }),

  confirm: (message, options) =>
    confirm(message, {
      title: options?.title,
      kind: options?.danger ? 'warning' : 'info',
    }),
};
