import type { AsrEngine, AsrEngineId, AsrEngineRegistry } from './AsrEngine';

export function createAsrEngineRegistry(
  apple: AsrEngine,
  mistral: AsrEngine,
  albert: AsrEngine,
): AsrEngineRegistry {
  const engines = new Map<AsrEngineId, AsrEngine>([
    ['apple-speech', apple],
    ['mistral-api', mistral],
    ['albert-api', albert],
  ]);

  return {
    get(id) {
      const engine = engines.get(id);
      if (!engine) throw new Error(`unknown transcription engine: ${id}`);
      return engine;
    },

    async available() {
      return Promise.all(
        [...engines.entries()].map(async ([id, engine]) => ({
          id,
          capabilities: engine.capabilities(),
          state: await engine.status(),
        })),
      );
    },

    async resolveConfiguredEngine(id) {
      const engine = this.get(id);
      const state = await engine.status();
      if (state.kind === 'unsupported') throw new Error(state.reason);
      if (state.kind === 'error') throw new Error(state.message ?? state.code);
      if (state.kind === 'not_configured') {
        throw new Error(
          id === 'albert-api' ? 'ASR_ALBERT_KEY_MISSING' : 'ASR_API_KEY_MISSING',
        );
      }
      return engine;
    },
  };
}
