/**
 * Self-update, behind the same boundary as every other Tauri API.
 *
 * The desktop build resolves this to `tauri-plugin-updater`, which reads the
 * signed `latest.json` published with each GitHub release, verifies the
 * download against the public key baked into `tauri.conf.json`, and swaps the
 * app bundle. The browser build has nothing to update and reports that rather
 * than pretending to check. *Calqo's updater adapter is the pattern.*
 */

/** Why a check could not run. Kept apart from an install failure so the
 * surface can say "this build cannot update itself" instead of "try again". */
export type UpdaterUnavailableReason = 'platform' | 'not-configured' | 'network';

export class UpdaterUnavailableError extends Error {
  constructor(
    readonly reason: UpdaterUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'UpdaterUnavailableError';
  }
}

/** Bytes so far; `total` is 0 when the server sent no content length. */
export interface UpdateDownloadProgress {
  downloaded: number;
  total: number;
}

/** A release newer than the running build. */
export interface AvailableUpdate {
  version: string;
  /** The release notes carried in the manifest, when there are any. */
  notes?: string;
  date?: string;
  /** Download, verify the signature, and replace the bundle on disk. Does not
   * restart — the running app keeps working until the student says so. */
  install(onProgress?: (progress: UpdateDownloadProgress) => void): Promise<void>;
  /** Release the backend handle when the update is not installed. Safe to call
   * more than once. */
  dispose(): Promise<void>;
}

export interface UpdaterAdapter {
  /** False when this build cannot update itself at all. */
  readonly supported: boolean;
  /** The newest release, or `null` when already up to date. Throws
   * `UpdaterUnavailableError` when the check itself could not run. */
  check(): Promise<AvailableUpdate | null>;
}
