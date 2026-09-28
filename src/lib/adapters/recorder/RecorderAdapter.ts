/**
 * Recording a lecture (plan §10.0).
 *
 * An adapter although `MediaRecorder` is a web API: whether the microphone is
 * read in the webview or in Rust is a platform decision, and it has to stay
 * changeable in one file. Today the webview captures and encodes, and Rust
 * owns the file — each slice is appended and flushed as it arrives, so a crash
 * keeps everything up to the last few seconds.
 *
 * Recording only ever starts from an explicit command. Nothing here resumes a
 * recording on launch; an interrupted one is *offered back* as a file, and the
 * microphone stays off.
 */
import type { Asset } from '@/lib/schema';

export type RecorderUnavailableReason =
  /** The browser shell, or a webview without `MediaRecorder`. */
  | 'unsupported'
  /** The student (or System Settings) said no to the microphone. */
  | 'denied'
  /** No input device. */
  | 'no_device';

/** Thrown by `start` and friends when recording cannot happen at all. */
export class RecorderUnavailableError extends Error {
  constructor(
    readonly reason: RecorderUnavailableReason,
    message = `recording unavailable: ${reason}`,
  ) {
    super(message);
    this.name = 'RecorderUnavailableError';
  }
}

export interface RecorderStartRequest {
  /** Minted by the caller; becomes the attachment's id when the recording is
   * kept, which is how an anchor finds its audio. */
  id: string;
  noteId: string;
  /** Input level, 0–1, a few times a second — the title bar's meter. */
  onLevel?(level: number): void;
  /**
   * Capture or the disk failed mid-recording. Everything acknowledged so far
   * is on disk and will be offered back; the session is over.
   */
  onFailure?(error: unknown): void;
}

export interface RecorderSession {
  id: string;
  /** Without parameters: `audio/mp4` from WebKit, `audio/webm` elsewhere. */
  mime: string;
  /** `Date.now()` when the encoder started — offset zero of every anchor. */
  startedAt: number;
  /** Stop, write the last slice, and move the audio into the asset store. */
  stop(): Promise<Asset>;
  /** Stop and throw the audio away. */
  cancel(): Promise<void>;
}

/** A recording that was still being written when the app stopped. */
export interface InterruptedRecording {
  id: string;
  noteId: string;
  mime: string;
  startedAt: string;
  bytes: number;
}

export interface RecorderAdapter {
  /** Whether recording can be offered at all. Never prompts. */
  supported(): boolean;
  start(request: RecorderStartRequest): Promise<RecorderSession>;
  interrupted(): Promise<InterruptedRecording[]>;
  /** Move an interrupted recording into the asset store, as `stop` would have. */
  recover(id: string): Promise<Asset>;
  discard(id: string): Promise<void>;
}
