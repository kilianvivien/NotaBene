/**
 * Text-to-speech, behind one interface so the engine can change without the
 * podcast pipeline noticing.
 *
 * v1 ships macOS system voices via a Swift bridge — no download, nothing leaves
 * the machine. v1.x adds Voxtral as a second implementation of this same
 * interface; the system engine stays as a permanent fallback for Macs that
 * cannot spare the gigabytes (PRD §5.6.4, §11).
 */
export interface TtsVoice {
  id: string;
  name: string;
  /** BCP-47, e.g. `en-US`, `fr-FR`. */
  locale: string;
  quality: 'standard' | 'enhanced' | 'premium';
}

export interface TtsRequest {
  text: string;
  voiceId: string;
  /** 1.0 is the voice's natural rate. */
  rate?: number;
  pitch?: number;
}

export interface TtsSegmentResult {
  audio: Blob;
  /** Milliseconds, used for paragraph-level seeking in the player. */
  durationMs: number;
}

export interface TtsEngine {
  readonly id: 'system' | 'voxtral';
  /** False when the engine's model has not been downloaded yet. */
  isAvailable(): Promise<boolean>;
  listVoices(): Promise<TtsVoice[]>;
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsSegmentResult>;
}
