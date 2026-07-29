import { openUrl } from '@tauri-apps/plugin-opener';
import type { ExternalLinkAdapter } from './ExternalLinkAdapter';

export const tauriExternalLinkAdapter: ExternalLinkAdapter = {
  open: (url) => openUrl(url),
};
