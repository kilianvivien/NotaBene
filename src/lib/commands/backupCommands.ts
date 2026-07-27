import { assets, dialog, exporter, library } from '@/lib/adapters';
import { createBackupArchive, parseBackupArchive, type ParsedBackup } from '@/lib/backup';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { fail, ok, type CommandResult } from './types';

function backupName(now = new Date()): string {
  return `NotaBene-${now.toISOString().slice(0, 10)}.notabene-backup`;
}

export async function writeBackupCommand(
  destination?: string,
): Promise<CommandResult<string | undefined>> {
  try {
    const exported = await library.exportLibrary();
    const archive = await createBackupArchive(exported);
    const result = await exporter.write({
      format: 'backup',
      destination,
      suggestedName: backupName(),
      files: [{ path: backupName(), contents: archive }],
    });
    if (!result.ok) return fail('storage_failed', result.error ?? 'Backup failed');
    await useSettingsStore.getState().update({ lastBackupAt: new Date().toISOString() });
    return ok(result.path);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function pickAndWriteBackupCommand(): Promise<CommandResult<string | undefined>> {
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
  try {
    return ok(await parseBackupArchive(await dialog.readFile(path)));
  } catch (error) {
    return fail('invalid_input', error instanceof Error ? error.message : String(error));
  }
}

export async function restoreBackupCommand(
  backup: ParsedBackup,
  mode: 'replace' | 'merge',
): Promise<CommandResult<void>> {
  try {
    await library.importLibrary(backup.library, mode);
    for (const [id, blob] of backup.assetBlobs) {
      const restored = await assets.put(blob, { mime: blob.type });
      if (restored.id !== id) throw new Error(`Asset ${id} changed while restoring`);
    }
    await useLibraryStore.getState().bootstrap();
    return ok(undefined);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function runScheduledBackupCommand(): Promise<CommandResult<boolean>> {
  const settings = useSettingsStore.getState().settings;
  if (settings.backupSchedule === 'off' || !settings.backupFolder) return ok(false);
  const interval =
    settings.backupSchedule === 'daily' ? 86_400_000 : 7 * 86_400_000;
  const last = settings.lastBackupAt ? Date.parse(settings.lastBackupAt) : 0;
  if (Date.now() - last < interval) return ok(false);
  const separator = settings.backupFolder.endsWith('/') ? '' : '/';
  const result = await writeBackupCommand(
    `${settings.backupFolder}${separator}${backupName()}`,
  );
  return result.ok ? ok(true) : result;
}
