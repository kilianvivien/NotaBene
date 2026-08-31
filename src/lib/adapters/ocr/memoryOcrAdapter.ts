import type { OcrAdapter } from './OcrAdapter';

/**
 * The browser build cannot read a page, and says so.
 *
 * Not an empty result: "this page had no text on it" and "this build has no
 * text recognition" are different answers, and returning the first for the
 * second would put a silently truncated document in front of someone.
 */
export const unavailableOcrAdapter: OcrAdapter = {
  async available() {
    return false;
  },
  async languages() {
    throw new Error('not_supported:text recognition needs the NotaBene desktop app');
  },
  async recognizePage() {
    throw new Error('not_supported:text recognition needs the NotaBene desktop app');
  },
};
