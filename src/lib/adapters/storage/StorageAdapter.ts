/**
 * What the app has on disk.
 *
 * Purely descriptive: this adapter measures, lists and verifies, but the only
 * thing it can delete is a backup archive NotaBene itself wrote into the folder
 * it manages. Notes are not reachable from here at all.
 */

/** Sizes in bytes, bucketed by what the file is rather than where it sits. */
export interface StorageSizes {
  databaseBytes: number;
  /** The write-ahead log beside the database. Normal, temporary, and reported
   * separately so a large one does not read as the library doubling. */
  walBytes: number;
  assetsBytes: number;
  backupsBytes: number;
  /** Local AI models the user downloaded — the speech ones today. Gigabytes
   * beside a library of megabytes, so never folded into "other". */
  modelsBytes: number;
  /** `settings.json` and the secret index — the size of them, never contents. */
  settingsBytes: number;
  otherBytes: number;
  totalBytes: number;
}

export interface StorageCounts {
  courses: number;
  notes: number;
  trashedNotes: number;
  attachments: number;
  snapshots: number;
  tags: number;
}

export interface StorageSummary extends StorageSizes {
  /** The movable folder containing notes and attachments. */
  libraryDir: string;
  /** App-local settings, models, secrets index, and managed backups. */
  appDataDir: string;
  /** The backup folder NotaBene manages inside it. */
  backupsDir: string;
  counts: StorageCounts;
  /** `PRAGMA quick_check` findings from launch. Empty when the database is
   * sound, which is the overwhelmingly common case. */
  startupProblems: string[];
}

export interface LibraryLockOwner {
  host: string;
  processId: number;
  updatedAt: string;
}

export interface LibraryAccessStatus {
  libraryDir: string;
  readOnly: boolean;
  lockOwner: LibraryLockOwner | null;
}

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
  /** Written automatically just before a restore, as the way back from one. */
  safety: boolean;
}

export interface IntegrityReport {
  ok: boolean;
  problems: string[];
}

export interface StorageAdapter {
  /** Null where the platform has no durable storage to describe. */
  summary(): Promise<StorageSummary | null>;
  /** Cheap live status used by the editor and status bar. */
  accessStatus(): Promise<LibraryAccessStatus | null>;
  /** Copy and verify into an empty destination, or verify and select an
   * existing library there. Never removes or overwrites either library. */
  relocateLibrary(destination: string): Promise<string>;
  /** The full `PRAGMA integrity_check`. Reports; never repairs. */
  integrityCheck(): Promise<IntegrityReport>;
  /** Absolute path of the managed backup folder, created if absent. */
  backupsDir(): Promise<string>;
  /** Fixed Downloads subfolder used by non-interactive MCP exports. */
  exportsDir(): Promise<string>;
  /** Archives in `folder`, or in the managed folder when omitted. */
  listBackups(folder?: string): Promise<BackupFile[]>;
  /**
   * Read an archive back off disk, by absolute path. Null where the platform
   * cannot — the caller then falls back to the file the user picked.
   *
   * Separate from the dialog's `readFile` because that one is bounded by the
   * webview's file scope, which does not extend to a backup folder chosen in
   * an earlier session. Verifying a written archive has to work wherever the
   * archive went, or it silently stops verifying.
   */
  readBackup(path: string): Promise<Blob | null>;
  /**
   * Delete all but the newest `keep` archives from the managed folder. It takes
   * no folder argument on purpose — a folder the user chose holds their files,
   * beside their own documents, and NotaBene never deletes from it.
   */
  pruneBackups(keep: number): Promise<number>;
  /** Show a path in the OS file manager. */
  reveal(path: string): Promise<void>;
}
