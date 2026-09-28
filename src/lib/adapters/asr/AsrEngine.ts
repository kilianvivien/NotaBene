/**
 * Engine-neutral speech-recognition contract (plan §10.3), the sibling of
 * `TtsEngine`.
 *
 * One pipeline drives every engine: decode, cut into windows, transcribe each
 * window, stitch, write the note (`transcriptionCommands.ts`). An engine
 * differs only in what it declares and in how it turns one window into
 * segments, so callers read capabilities rather than branching on an id.
 */
import type { TranscriptSegment } from '@/lib/schema';
import type { TtsEngineState } from '../tts/TtsEngine';

/**
 * `apple-speech` is macOS's own on-device recogniser (`SpeechTranscriber`,
 * macOS 26+), and the default: nothing leaves the Mac and there is no model
 * of ours to pin. `mistral-api` is opt-in and sends each window to Mistral
 * with the student's key. The CrispASR engines of
 * `docs/transcription-1.3.5.md` are not in this release.
 */
export type AsrEngineId = 'apple-speech' | 'mistral-api';

/** The languages a lecture may be transcribed in. */
export type AsrLanguage = 'fr' | 'en';

export interface AsrEngineCapabilities {
  local: boolean;
  /** Window length and overlap this engine wants, in seconds. */
  window: { seconds: number; overlapSeconds: number };
  /** Words with their own start and end. */
  wordTimestamps: boolean;
  /** Real per-word confidences, which is what review highlights need. */
  confidences: boolean;
  /** Whether a language hint is honoured. Mistral's timestamps and its
   * language field are documented as incompatible, so it always detects. */
  languageHint: boolean;
  /** How the course's accepted terms reach the engine, if at all. */
  vocabulary: 'contextual-strings' | 'context-bias' | false;
  maxVocabularyTerms: number;
  /** For a hosted engine, whose servers hear the audio. */
  provider: 'mistral' | null;
}

export type AsrEngineState = TtsEngineState;

export interface AsrWindow {
  index: number;
  startMs: number;
  endMs: number;
}

/** A decoded lecture waiting in Rust. The audio is named, never carried. */
export interface AsrJob {
  jobId: string;
  durationMs: number;
  windows: AsrWindow[];
}

export interface AsrWindowOptions {
  /** `null` lets the engine decide. */
  language: AsrLanguage | null;
  vocabulary: string[];
  signal?: AbortSignal;
}

export interface AsrWindowResult {
  /** Times relative to the window's start. */
  segments: TranscriptSegment[];
  language: string | null;
}

export interface AsrEngine {
  readonly id: AsrEngineId;
  capabilities(): AsrEngineCapabilities;
  status(): Promise<AsrEngineState>;
  /** Pick one of `candidates` from the lecture's first speech, for engines
   * that need a language and cannot detect one inside a window. */
  detectLanguage?(
    job: AsrJob,
    candidates: AsrLanguage[],
    signal?: AbortSignal,
  ): Promise<AsrLanguage>;
  transcribeWindow(
    job: AsrJob,
    window: AsrWindow,
    options: AsrWindowOptions,
  ): Promise<AsrWindowResult>;
}

export interface AsrEngineSummary {
  id: AsrEngineId;
  capabilities: AsrEngineCapabilities;
  state: AsrEngineState;
}

export interface AsrEngineRegistry {
  get(id: AsrEngineId): AsrEngine;
  available(): Promise<AsrEngineSummary[]>;
  /** The engine, or an `ASR_*` error naming why it cannot run. Never another
   * engine in its place: a local failure is not a reason to upload. */
  resolveConfiguredEngine(id: AsrEngineId): Promise<AsrEngine>;
}
