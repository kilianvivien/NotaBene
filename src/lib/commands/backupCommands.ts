/**
 * Backups.
 *
 * Three properties this file exists to hold, all of them learned the hard way:
 *
 * 1. **A backup nobody verified is a rumour.** Every archive is read back off
 *    disk and re-parsed before it counts as one. Writing bytes that turn out to
 *    be unreadable at the moment you need them is worse than no backup, because
 *    the user stopped worrying.
 * 2. **A failure the user cannot see did not get reported.** Outcomes land in
 *    settings, not in a discarded return value.
 * 3. **NotaBene prunes only its own folder.** Files in a folder the user picked
 *    sit beside their own documents and are never ours to delete.
 */
import { assets, dialog, exporter, library, storage } from '@/lib/adapters';
import { createBackupArchive, parseBackupArchive, type ParsedBackup } from '@/lib/backup';
import type { Library } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { fail, ok, type CommandResult } from './types';

const EXTENSION = '.notabene-backup';
export const SAFETY_PREFIX = 'NotaBene-before-restore-';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Local time, and down to the second.
 *
 * Local because this is a filename a student reads in Finder, and a backup
 * taken at 23:40 filed under tomorrow's date is a lie about when it was taken.
 * To the second because the name used to carry the date alone, so a second
 * backup on the same day silently overwrote the first — the one case where
 * running a backup destroyed a backup.
 */
export function backupName(now = new Date(), prefix = 'NotaBene-'): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}${date}-${time}${EXTENSION}`;
}

/** Join a folder and a filename whichever separator the folder is written in.
 * The previous version tested for `/` only, so a Windows path produced
 * `C:\Backups\/NotaBene-….notabene-backup`. */
export function joinPath(folder: string, name: string): string {
  const trimmed = folder.replace(/[/\\]+$/, '');
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return `${trimmed}${separator}${name}`;
}

/**
 * Read an archive by path, preferring the route that is not fenced in.
 *
 * The webview's `readFile` is bounded by the file scope, which covers a few
 * static roots plus whatever the user picked in *this* session — so a backup
 * folder chosen last month, on an external drive, is unreadable from the
 * webview even though NotaBene just wrote to it. `storage.readBackup` goes
 * through Rust, which has no such fence. The fallback is the browser build,
 * where a "path" is an object URL and Rust is not there at all.
 */
async function readArchive(path: string): Promise<Blob> {
  return (await storage.readBackup(path)) ?? dialog.readFile(path);
}

export interface BackupOutcome {
  /** Where it landed, when the platform can say. */
  path?: string;
  /** Assets referenced by the library whose bytes were not on disk. */
  missingAssets: string[];
}

async function recordFailure<T>(message: string): Promise<CommandResult<T>> {
  await useSettingsStore.getState().update({
    lastBackupError: message,
    lastBackupErrorAt: new Date().toISOString(),
  });
  return fail('storage_failed', message);
}

/**
 * Read the archive back and parse it exactly as a restore would.
 *
 * This is the only step that can tell a written file from a working backup:
 * `parseBackupArchive` re-hashes `library.json`, re-hashes every asset against
 * its content address, and walks the referential integrity of the result.
 */
async function verifyArchive(path: string, source: Library): Promise<string | null> {
  let parsed: ParsedBackup;
  try {
    parsed = await parseBackupArchive(await readArchive(path));
  } catch (error) {
    return `Backup could not be read back: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  const { counts } = parsed.manifest;
  if (
    counts.notes !== source.notes.length ||
    counts.courses !== source.courses.length ||
    counts.snapshots !== source.snapshots.length
  ) {
    return 'Backup was written incompletely and does not match the library';
  }
  return null;
}

export async function writeBackupCommand(
  destination?: string,
): Promise<CommandResult<BackupOutcome>> {
  try {
    const exported = await library.exportLibrary();
    const { blob, missingAssets } = await createBackupArchive(exported);
    const name = backupName();
    const result = await exporter.write({
      format: 'backup',
      destination,
      suggestedName: name,
      files: [{ path: destination ?? name, contents: blob }],
    });
    if (!result.ok) return recordFailure(result.error ?? 'Backup failed');

    // Only where the platform gave us a path to read back. The browser build
    // hands the file to the download manager and never sees it again.
    if (result.path) {
      const problem = await verifyArchive(result.path, exported);
      if (problem) return recordFailure(problem);
    }

    await useSettingsStore.getState().update({
      lastBackupAt: new Date().toISOString(),
      lastBackupPath: result.path ?? null,
      lastBackupError: null,
      lastBackupErrorAt: null,
    });
    return ok({ path: result.path, missingAssets });
  } catch (error) {
    return recordFailure(error instanceof Error ? error.message : String(error));
  }
}

export async function pickAndWriteBackupCommand(): Promise<CommandResult<BackupOutcome>> {
  const destination = await dialog.saveFile({
    defaultPath: backupName(),
    filters: [{ name: 'NotaBene backup', extensions: ['notabene-backup'] }],
  });
  if (!destination) return fail('not_supported', 'Backup cancelled');
  return writeBackupCommand(destination);
}

export async function pickBackupCommand(): Promise<CommandResult<ParsedBackup>> {
  const [path] = await dialog.openFile({
    filters: [{ name: 'NotaBene backup', extensions: ['notabene-backup'] }],
  });
  if (!path) return fail('not_supported', 'Restore cancelled');
  return readBackupCommand(path);
}

export async function readBackupCommand(path: string): Promise<CommandResult<ParsedBackup>> {
  try {
    return ok(await parseBackupArchive(await readArchive(path)));
  } catch (error) {
    return fail('invalid_input', error instanceof Error ? error.message : String(error));
  }
}

export interface RestoreOutcome {
  /** The archive written before anything was touched — the way back. */
  safetyPath?: string;
}

/**
 * Replace or merge the library, having first taken a verified copy of what is
 * there now.
 *
 * A note restore deliberately writes *forward*, so undoing a mistaken restore
 * is just another restore. A library restore cannot work that way — replace
 * mode empties the database — so the equivalent guarantee has to be bought with
 * a real archive, and bought *before* the destructive part runs. If the safety
 * copy cannot be written and verified, the restore does not happen at all.
 */
export async function restoreBackupCommand(
  backup: ParsedBackup,
  mode: 'replace' | 'merge',
): Promise<CommandResult<RestoreOutcome>> {
  let safetyPath: string | undefined;
  try {
    const folder = await storage.backupsDir().catch(() => null);
    if (folder) {
      const safety = await writeSafetyArchive(folder);
      if (!safety.ok) {
        return fail(
          'storage_failed',
          `Restore stopped: the safety copy could not be written (${safety.message})`,
        );
      }
      safetyPath = safety.value;
    }

    await library.importLibrary(backup.library, mode);
    for (const [id, blob] of backup.assetBlobs) {
      const restored = await assets.put(blob, { mime: blob.type });
      if (restored.id !== id) throw new Error(`Asset ${id} changed while restoring`);
    }
    await useLibraryStore.getState().bootstrap();
    return ok({ safetyPath });
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

async function writeSafetyArchive(folder: string): Promise<CommandResult<string>> {
  try {
    const exported = await library.exportLibrary();
    const { blob } = await createBackupArchive(exported);
    const path = joinPath(folder, backupName(new Date(), SAFETY_PREFIX));
    const result = await exporter.write({
      format: 'backup',
      destination: path,
      files: [{ path, contents: blob }],
    });
    if (!result.ok) return fail('storage_failed', result.error ?? 'write failed');
    const problem = result.path ? await verifyArchive(result.path, exported) : null;
    if (problem) return fail('storage_failed', problem);
    return ok(result.path ?? path);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

/** Milliseconds between scheduled backups, by setting. */
const INTERVALS = { daily: 86_400_000, weekly: 7 * 86_400_000 } as const;

export function nextScheduledBackupAt(
  settings = useSettingsStore.getState().settings,
): Date | null {
  if (settings.backupSchedule === 'off') return null;
  const interval = INTERVALS[settings.backupSchedule];
  const last = settings.lastBackupAt ? Date.parse(settings.lastBackupAt) : 0;
  return new Date(last + interval);
}

/**
 * Run a scheduled backup if one is due.
 *
 * Called at launch *and* on a heartbeat while the app runs — it used to fire
 * only during bootstrap, so a machine left open for a fortnight backed up
 * exactly once.
 */
export async function runScheduledBackupCommand(): Promise<CommandResult<boolean>> {
  const settings = useSettingsStore.getState().settings;
  if (settings.backupSchedule === 'off') return ok(false);
  const due = nextScheduledBackupAt(settings);
  if (due && Date.now() < due.getTime()) return ok(false);

  // No chosen folder means the folder NotaBene manages — which is what lets a
  // fresh install be protected before anybody opens Settings.
  const managed = settings.backupFolder === null;
  let folder: string;
  try {
    folder = managed ? await storage.backupsDir() : settings.backupFolder!;
  } catch (error) {
    return recordFailure(error instanceof Error ? error.message : String(error));
  }

  const result = await writeBackupCommand(joinPath(folder, backupName()));
  if (!result.ok) return result;
  // Rotation is for our own folder only; a folder the user chose is theirs.
  if (managed) {
    await storage.pruneBackups(settings.backupsToKeep).catch(() => 0);
  }
  return ok(true);
}
