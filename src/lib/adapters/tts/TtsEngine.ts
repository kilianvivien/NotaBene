/**
 * Engine-neutral text-to-speech contract.
 *
 * Every engine returns a completed segment: macOS `say(1)` and the hosted
 * hosted speech APIs do. Callers inspect capabilities instead of inferring them
 * from an engine id.
 */
export type TtsEngineId = 'system' | 'mistral-api' | 'gemini-api' | 'openai-compatible';

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
  | { kind: 'ready' }
  | { kind: 'error'; code: string; recoverable: boolean; message?: string };

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
