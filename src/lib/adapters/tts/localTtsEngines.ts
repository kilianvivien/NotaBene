import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from '@/lib/platform/runtime';
import type {
  TtsEngine,
  TtsEngineCapabilities,
  TtsEngineState,
  TtsRequest,
  TtsVoice,
} from './TtsEngine';
import { decodeNativeWav } from './wav';

export type ManagedLocalEngineId = 'voxtral-local' | 'kokoro-local';
export type LocalModelStatusKind =
  | 'unsupported'
  | 'not_installed'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'loading'
  | 'error';

export interface LocalModelStatus {
  kind: LocalModelStatusKind;
  supported: boolean;
  modelRevision: string;
  modelSizeBytes: number;
  downloadedBytes: number;
  totalBytes: number;
  loaded: boolean;
  errorCode: string | null;
  message: string | null;
}

export const LOCAL_MODEL_REVISIONS: Record<ManagedLocalEngineId, string> = {
  'voxtral-local': 'a50d89a51997d49b8b3b55836aebf064c4a978e0',
  'kokoro-local': 'f20291b3a27d0900af358ea1c87d63c76183b223',
};

const LOCAL_MODEL_SIZES: Record<ManagedLocalEngineId, number> = {
  'voxtral-local': 2_353_230_080,
  'kokoro-local': 152_825_855,
};

const COMMAND_PREFIX: Record<ManagedLocalEngineId, string> = {
  'voxtral-local': 'tts_voxtral',
  'kokoro-local': 'tts_kokoro',
};

const EVENT_NAME: Record<ManagedLocalEngineId, string> = {
  'voxtral-local': 'notabene-voxtral-install-progress',
  'kokoro-local': 'notabene-kokoro-install-progress',
};

const CAPABILITIES: TtsEngineCapabilities = {
  local: true,
  streaming: false,
  supportsRate: 'playback',
  supportsPitch: false,
  supportsVoiceCloning: false,
  sampleRateHz: 24_000,
  channels: 1,
  formats: ['wav'],
};

function command(id: ManagedLocalEngineId, action: string): string {
  return `${COMMAND_PREFIX[id]}_${action}`;
}

function unsupportedStatus(id: ManagedLocalEngineId): LocalModelStatus {
  return {
    kind: 'unsupported',
    supported: false,
    modelRevision: LOCAL_MODEL_REVISIONS[id],
    modelSizeBytes: LOCAL_MODEL_SIZES[id],
    downloadedBytes: 0,
    totalBytes: LOCAL_MODEL_SIZES[id],
    loaded: false,
    errorCode: 'TTS_UNSUPPORTED_OS',
    message: 'Local neural speech requires the Apple Silicon desktop app.',
  };
}

function publicState(status: LocalModelStatus): TtsEngineState {
  switch (status.kind) {
    case 'ready':
    case 'loading':
      return { kind: 'ready' };
    case 'unsupported':
      return {
        kind: 'unsupported',
        code: status.errorCode ?? 'TTS_UNSUPPORTED_OS',
        reason: status.message ?? 'Local speech requires an Apple Silicon Mac.',
      };
    case 'error':
      return {
        kind: 'error',
        code: status.errorCode ?? 'TTS_MODEL_INCOMPLETE',
        recoverable: true,
        message: status.message ?? undefined,
      };
    default:
      return { kind: 'not_configured' };
  }
}

export const localTtsModels = {
  status(id: ManagedLocalEngineId): Promise<LocalModelStatus> {
    if (!isTauri) return Promise.resolve(unsupportedStatus(id));
    return invoke(command(id, 'status'));
  },
  install(id: ManagedLocalEngineId, acceptedLicense: boolean): Promise<LocalModelStatus> {
    if (!isTauri) {
      return Promise.reject(
        new Error('TTS_UNSUPPORTED_OS: Local speech requires the desktop app.'),
      );
    }
    return invoke(command(id, 'install'), { acceptedLicense });
  },
  cancelInstall(id: ManagedLocalEngineId): Promise<void> {
    if (!isTauri) return Promise.resolve();
    return invoke(command(id, 'cancel_install'));
  },
  remove(id: ManagedLocalEngineId): Promise<LocalModelStatus> {
    if (!isTauri) return Promise.resolve(unsupportedStatus(id));
    return invoke(command(id, 'remove'));
  },
  unload(id: ManagedLocalEngineId): Promise<LocalModelStatus> {
    if (!isTauri) return Promise.resolve(unsupportedStatus(id));
    return invoke(command(id, 'unload'));
  },
  listen(
    id: ManagedLocalEngineId,
    handler: (status: LocalModelStatus) => void,
  ): Promise<UnlistenFn> {
    if (!isTauri) return Promise.resolve(() => {});
    return listen<LocalModelStatus>(EVENT_NAME[id], (event) => handler(event.payload));
  },
};

export function createLocalTtsEngine(id: ManagedLocalEngineId): TtsEngine {
  return {
    id,
    async capabilities() {
      return CAPABILITIES;
    },
    async status() {
      return publicState(await localTtsModels.status(id));
    },
    async isAvailable() {
      const kind = (await localTtsModels.status(id)).kind;
      return kind === 'ready' || kind === 'loading';
    },
    listVoices() {
      return invoke<TtsVoice[]>(command(id, 'voices'));
    },
    async synthesize(request: TtsRequest, signal?: AbortSignal) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const result = await invoke<{
        data: string;
        mime: string;
        durationMs: number;
        sampleRateHz: number;
        channels: number;
      }>(command(id, 'synthesize'), { request });
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      return decodeNativeWav(result, {
        sampleRateHz: 24_000,
        channels: 1,
        bitsPerSample: 16,
      });
    },
  };
}

export function unavailableLocalTtsEngine(id: ManagedLocalEngineId): TtsEngine {
  return {
    id,
    async capabilities() {
      return CAPABILITIES;
    },
    async status() {
      return {
        kind: 'unsupported',
        code: 'TTS_UNSUPPORTED_OS',
        reason: 'Local speech requires the desktop app on an Apple Silicon Mac.',
      };
    },
    async isAvailable() {
      return false;
    },
    async listVoices() {
      return [];
    },
    async synthesize() {
      throw new Error('TTS_UNSUPPORTED_OS: Local speech requires the desktop app.');
    },
  };
}
