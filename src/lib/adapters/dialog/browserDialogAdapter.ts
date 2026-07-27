/** Browser dialogs use object URLs where the desktop adapter uses paths. */
import type { DialogAdapter } from './DialogAdapter';

export const browserDialogAdapter: DialogAdapter = {
  async openFile(options) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = options?.multiple ?? false;
      input.accept =
        options?.filters
          ?.flatMap((filter) => filter.extensions.map((extension) => `.${extension}`))
          .join(',') ?? '';
      input.addEventListener(
        'change',
        () =>
          resolve(
            Array.from(input.files ?? []).map((file) => URL.createObjectURL(file)),
          ),
        { once: true },
      );
      input.addEventListener('cancel', () => resolve([]), { once: true });
      input.click();
    });
  },
  async openFolder() {
    return null;
  },
  async readFile(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error('Could not read selected file');
    return response.blob();
  },
  async saveFile(options) {
    return options?.defaultPath ?? 'export';
  },
  async confirm(message) {
    return window.confirm(message);
  },
};
