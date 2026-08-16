import { invoke } from '@tauri-apps/api/core';
import type { FetchedPage, WebAdapter } from './WebAdapter';

export const tauriWebAdapter: WebAdapter = {
  fetchPage: (url: string): Promise<FetchedPage> => invoke('web_fetch_page', { url }),
};

/**
 * The browser build cannot do this, and should not pretend to.
 *
 * `fetch` from the webview would be blocked by `connect-src` anyway, and
 * widening that policy to reach the whole web is precisely what routing the
 * request through Rust avoids.
 */
export const unavailableWebAdapter: WebAdapter = {
  fetchPage: async () => {
    throw new Error('unsupported:saving a web page needs the desktop app');
  },
};
