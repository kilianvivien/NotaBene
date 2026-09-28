import { RecorderUnavailableError, type RecorderAdapter } from './RecorderAdapter';

/**
 * The browser shell. Loud rather than quiet: a Record button that did
 * nothing would be the worst possible failure for a feature whose promise is
 * that the lecture was kept.
 */
export const unavailableRecorderAdapter: RecorderAdapter = {
  supported: () => false,
  start: async () => {
    throw new RecorderUnavailableError('unsupported');
  },
  listInputs: async () => [],
  monitor: async () => {
    throw new RecorderUnavailableError('unsupported');
  },
  interrupted: async () => [],
  recover: async () => {
    throw new RecorderUnavailableError('unsupported');
  },
  discard: async () => undefined,
};
