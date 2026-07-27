/** Browser dialogs. Paths are not a browser concept, so the file pickers here
 * are intentionally inert: the dev shell exercises layout, not file I/O. */
import type { DialogAdapter } from './DialogAdapter';

export const browserDialogAdapter: DialogAdapter = {
  async openFile() {
    return [];
  },
  async openFolder() {
    return null;
  },
  async saveFile() {
    return null;
  },
  async confirm(message) {
    return window.confirm(message);
  },
};
