import type { ExternalLinkAdapter } from './ExternalLinkAdapter';

export const browserExternalLinkAdapter: ExternalLinkAdapter = {
  async open(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};
