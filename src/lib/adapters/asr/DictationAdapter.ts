import type { RecordingInput } from '../recorder/RecorderAdapter';

export interface DictationRequest {
  apiKey: string;
  input: RecordingInput;
  vocabulary: string[];
  signal: AbortSignal;
  onText(text: string): void;
  onLevel(level: number): void;
  onFailure(error: unknown): void;
}

export interface DictationSession {
  /** Release the microphone immediately, then drain the final transcript. */
  stop(): Promise<void>;
  cancel(): Promise<void>;
}

export interface DictationAdapter {
  supported(): boolean;
  start(request: DictationRequest): Promise<DictationSession>;
}
