/**
 * Transcription's platform half: the audio, and Apple's recogniser (plan
 * §10.3). Rust reads a lecture from the asset store by id, decodes it once
 * into a job directory, and hands engines a window at a time; the webview
 * only ever names a job and a window.
 */
import type { AppleSpeechStatus } from '@/lib/schema';
import type { AsrJob } from './AsrEngine';

export interface AsrPrepareRequest {
  jobId: string;
  assetId: string;
  windowSeconds: number;
  overlapSeconds: number;
}

export interface AsrAdapter {
  /** Whether transcription can be offered at all. */
  supported(): boolean;
  prepare(request: AsrPrepareRequest): Promise<AsrJob>;
  /** Kill whatever the job is running now. */
  cancel(jobId: string): Promise<void>;
  /** Delete the job's files. Safe to call twice, or for a job that never
   * finished preparing. */
  release(jobId: string): Promise<void>;
  /** Apple's recogniser: which languages it has, and whether each model is
   * installed. Never downloads. */
  appleStatus(locales: string[]): Promise<AppleSpeechStatus>;
  /** Install one language's model — Apple's download, on the student's
   * click only. */
  appleInstall(locale: string, onProgress?: (fraction: number) => void): Promise<void>;
  appleDetect(jobId: string, locales: string[]): Promise<unknown>;
  appleTranscribe(
    jobId: string,
    index: number,
    locale: string,
    context: string[],
  ): Promise<unknown>;
}
