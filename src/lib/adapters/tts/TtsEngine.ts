/**
 * Engine-neutral text-to-speech contract.
 *
 * Streams are the primary operation. `synthesize` remains as a convenience for
 * exports and for the system engine, which can only return a completed WAV.
 * Callers inspect capabilities instead of inferring them from an engine id.
 */
export type TtsEngineId =
  'system' | 'voxtral-local' | 'mistral-api' | 'openai-compatible';

export interface TtsVoice {
  id: string;
  name: string;
  /** BCP-47, e.g. `en-US`, `fr-FR`; `mul` means multilingual. */
  locale: string;
  quality: 'standard' | 'enhanced' | 'premium';
}

export type TtsAudioEncoding = 'pcm_s16le' | 'wav' | 'mp3';

export interface TtsEngineCapabilities {
  local: boolean;
  streaming: boolean;
  supportsRate: 'synthesis' | 'playback' | false;
  supportsPitch: boolean;
  supportsVoiceCloning: boolean;
  sampleRateHz: number | null;
  channels: 1 | 2 | null;
  formats: TtsAudioEncoding[];
}

export type TtsEngineState =
  | { kind: 'unsupported'; reason: string; code?: string }
  | { kind: 'not_configured' }
  | { kind: 'not_installed' }
  | { kind: 'downloading'; downloadedBytes: number; totalBytes: number }
  | { kind: 'verifying' }
  | { kind: 'installed' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'busy'; jobId: string }
  | { kind: 'error'; code: string; recoverable: boolean; message?: string };

export interface TtsStreamRequest {
  text: string;
  voiceId: string;
  /** Player speed. Engines expose whether they apply it during synthesis. */
  playbackRate?: number;
  requestId: string;
}

export type TtsAudioEvent =
  | {
      type: 'started';
      requestId: string;
      sampleRateHz: number;
      channels: 1 | 2;
      encoding: TtsAudioEncoding;
    }
  | {
      type: 'audio';
      requestId: string;
      sequence: number;
      dataBase64: string;
      /** PCM frames for raw PCM, or the decoded frame count for a container. */
      sampleCount: number;
    }
  | {
      type: 'progress';
      requestId: string;
      generatedSamples: number;
    }
  | {
      type: 'done';
      requestId: string;
      totalSamples: number;
      durationMs: number;
    }
  | {
      type: 'error';
      requestId: string;
      code: string;
      message: string;
      recoverable: boolean;
    };

/** Legacy alias retained for call sites that build one-shot requests. */
export interface TtsRequest {
  text: string;
  voiceId: string;
  rate?: number;
  pitch?: number;
}

export interface TtsSegmentResult {
  audio: Blob;
  /** Milliseconds, used for paragraph-level seeking in the player. */
  durationMs: number;
  sampleRateHz?: number;
  channels?: 1 | 2;
}

export interface TtsEngine {
  readonly id: TtsEngineId;
  capabilities(): Promise<TtsEngineCapabilities>;
  status(): Promise<TtsEngineState>;
  /** Compatibility convenience for older capability checks. */
  isAvailable(): Promise<boolean>;
  listVoices(): Promise<TtsVoice[]>;
  synthesizeStream(
    request: TtsStreamRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TtsAudioEvent>;
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsSegmentResult>;
}

export interface TtsEngineSummary {
  id: TtsEngineId;
  capabilities: TtsEngineCapabilities;
  state: TtsEngineState;
}

export interface TtsEngineRegistry {
  get(id: TtsEngineId): TtsEngine;
  available(): Promise<TtsEngineSummary[]>;
  resolveConfiguredEngine(id: TtsEngineId): Promise<TtsEngine>;
}
