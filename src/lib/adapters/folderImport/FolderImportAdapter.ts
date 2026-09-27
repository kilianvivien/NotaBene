/**
 * Reading a folder of notes another app wrote, behind the platform boundary.
 *
 * The desktop build walks and reads in Rust (`src-tauri/src/folder_import.rs`),
 * because `fs` is scoped to four directories and a vault lives wherever its
 * owner put it. Rust also owns the folder picker: a root the student did not
 * choose in the native panel is refused, so this interface has no way to name
 * one. Nothing here writes; readers and the command layer decide what becomes
 * a note.
 */

export interface FolderEntry {
  /** Relative to the root, `/`-separated. */
  path: string;
  bytes: number;
  modifiedAt: string | null;
  createdAt: string | null;
}

export interface FolderSkip {
  path: string;
  /** `symlink`, `tooLarge`, `tooDeep`, `unreadable`. */
  reason: string;
}

export interface FolderManifest {
  root: string;
  files: FolderEntry[];
  skipped: FolderSkip[];
  /** The walk stopped at its file ceiling; what follows was never seen. */
  truncated: boolean;
}

export interface FolderImportAdapter {
  /** False on a build that cannot read folders at all — the choice stays
   * visible and disabled rather than disappearing. */
  readonly supported: boolean;
  /** Open the folder panel. `null` when the student cancelled. */
  pickFolder(): Promise<string | null>;
  scan(root: string): Promise<FolderManifest>;
  readText(root: string, paths: string[]): Promise<Map<string, string>>;
  readBytes(root: string, paths: string[]): Promise<Map<string, Blob>>;
}
