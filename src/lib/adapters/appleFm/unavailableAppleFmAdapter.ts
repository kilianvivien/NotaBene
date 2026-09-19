import type { AppleFmAdapter } from './AppleFmAdapter';

export const unavailableAppleFmAdapter: AppleFmAdapter = {
  async preflight() {
    return {
      installed: false,
      osOk: false,
      licensed: false,
      model: 'unknown',
      detail: null,
    };
  },
  async start() {
    throw new Error('Apple Foundation Models require the NotaBene desktop app on macOS 27');
  },
  async stop() {},
  async status() {
    return { running: false, port: null, managed: false, error: null };
  },
  async countTokens() {
    throw new Error('Apple Foundation Models require the NotaBene desktop app on macOS 27');
  },
};
