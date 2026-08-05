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
  /** The one directory everything lives in. */
  dataDir: string;
  /** The backup folder NotaBene manages inside it. */
  backupsDir: string;
  counts: StorageCounts;
  /** `PRAGMA quick_check` findings from launch. Empty when the database is
   * sound, which is the overwhelmingly common case. */
  startupProblems: string[];
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
  /** The full `PRAGMA integrity_check`. Reports; never repairs. */
  integrityCheck(): Promise<IntegrityReport>;
  /** Absolute path of the managed backup folder, created if absent. */
  backupsDir(): Promise<string>;
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
