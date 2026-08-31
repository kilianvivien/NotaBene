import { invoke } from '@tauri-apps/api/core';
import { encodeBlobBase64 } from '@/lib/archive/base64';
import { OcrPageSchema } from '@/lib/schema';
import type { OcrAdapter } from './OcrAdapter';

export const tauriOcrAdapter: OcrAdapter = {
  async available() {
    return await invoke<boolean>('ocr_available');
  },
  async languages() {
    return await invoke<string[]>('ocr_languages');
  },
  async recognizePage(image, languages) {
    return OcrPageSchema.parse(
      await invoke('ocr_recognize_page', {
        data: await encodeBlobBase64(image),
        languages,
      }),
    );
  },
};
