import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { decodeBase64 } from '@/lib/archive/base64';
import type {
  BackupFile,
  IntegrityReport,
  StorageAdapter,
  StorageSummary,
} from './StorageAdapter';

export const tauriStorageAdapter: StorageAdapter = {
  summary: () => invoke<StorageSummary>('storage_summary'),
  integrityCheck: () => invoke<IntegrityReport>('db_integrity_check'),
  backupsDir: () => invoke<string>('backups_dir'),
  exportsDir: () => invoke<string>('exports_dir'),
  listBackups: (folder?: string) => invoke<BackupFile[]>('backups_list', { folder }),
  readBackup: async (path: string) =>
    new Blob([await decodeBase64(await invoke<string>('backups_read', { path }))], {
      type: 'application/x-notabene-backup',
    }),
  pruneBackups: (keep: number) => invoke<number>('backups_prune', { keep }),
  reveal: (path: string) => revealItemInDir(path),
};

/**
 * The browser build keeps its library in memory, so there is nothing on disk to
 * describe. `summary()` returns null rather than zeroes: a pane full of "0 B" is
 * a claim about storage, and the honest answer is that there is none.
 */
export const unavailableStorageAdapter: StorageAdapter = {
  async summary(): Promise<StorageSummary | null> {
    return null;
  },
  async integrityCheck(): Promise<IntegrityReport> {
    throw new Error('checking the database requires the desktop app');
  },
  async backupsDir(): Promise<string> {
    throw new Error('managed backups require the desktop app');
  },
  async exportsDir(): Promise<string> {
    throw new Error('managed exports require the desktop app');
  },
  async listBackups(): Promise<BackupFile[]> {
    return [];
  },
  async readBackup(): Promise<Blob | null> {
    return null;
  },
  async pruneBackups(): Promise<number> {
    return 0;
  },
  async reveal(): Promise<void> {
    throw new Error('revealing a file requires the desktop app');
  },
};
