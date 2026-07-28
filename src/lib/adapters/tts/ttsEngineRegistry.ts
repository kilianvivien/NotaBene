import type {
  TtsEngine,
  TtsEngineId,
  TtsEngineRegistry,
  TtsEngineSummary,
} from './TtsEngine';

const FUTURE_ENGINES = new Set<TtsEngineId>(['mistral-api', 'openai-compatible']);

export function createTtsEngineRegistry(
  system: TtsEngine,
  voxtral: TtsEngine,
): TtsEngineRegistry {
  const engines = new Map<TtsEngineId, TtsEngine>([
    ['system', system],
    ['voxtral-local', voxtral],
  ]);

  return {
    get(id) {
      const engine = engines.get(id);
      if (engine) return engine;
      if (FUTURE_ENGINES.has(id)) {
        throw new Error(`${id} is not configured in this release`);
      }
      throw new Error(`unknown TTS engine: ${id}`);
    },

    async available(): Promise<TtsEngineSummary[]> {
      return Promise.all(
        [...engines.entries()].map(async ([id, engine]) => ({
          id,
          capabilities: await engine.capabilities(),
          state: await engine.status(),
        })),
      );
    },

    async resolveConfiguredEngine(id) {
      const engine = this.get(id);
      const state = await engine.status();
      if (state.kind === 'unsupported' || state.kind === 'error') {
        throw new Error(
          state.kind === 'unsupported' ? state.reason : (state.message ?? state.code),
        );
      }
      if (state.kind === 'not_installed') {
        throw new Error('TTS_MODEL_NOT_INSTALLED: Voxtral is not installed');
      }
      return engine;
    },
  };
}
