/**
 * The properties that make a backup worth having.
 *
 * These run against a fake disk — a `Map` standing in for `export_write` and
 * `readFile` — because the behaviour under test is what the command layer does
 * with the bytes, not how they reach the filesystem. The real desktop writer is
 * exercised end to end by the manual restore pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dialog, exporter, library, storage, DEFAULT_SETTINGS } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { createNoteCommand } from './noteCommands';
import {
  backupName,
  joinPath,
  pickBackupCommand,
  restoreBackupCommand,
  runScheduledBackupCommand,
  writeBackupCommand,
} from './backupCommands';
import type { NoteDoc } from '@/lib/schema';

const MANAGED = '/managed-backups';
const disk = new Map<string, Blob>();

/** Set by a test that wants the next write to land damaged or fail outright. */
let sabotage: 'none' | 'corrupt' | 'fail' = 'none';

function docOf(text: string): NoteDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function settings() {
  return useSettingsStore.getState().settings;
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  disk.clear();
  sabotage = 'none';
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });

  vi.spyOn(exporter, 'write').mockImplementation(async (request) => {
    if (sabotage === 'fail') return { ok: false, error: 'disk full' };
    const path = request.destination ?? request.suggestedName ?? request.files[0]!.path;
    const contents = request.files[0]!.contents;
    disk.set(
      path,
      // A half-written zip is what a full disk or a yanked drive actually
      // leaves behind, and it is the case the old code counted as a success.
      sabotage === 'corrupt' ? contents.slice(0, Math.floor(contents.size / 2)) : contents,
    );
    return { ok: true, path };
  });
  vi.spyOn(dialog, 'readFile').mockImplementation(async (path: string) => {
    const blob = disk.get(path);
    if (!blob) throw new Error(`nothing at ${path}`);
    return blob;
  });
  vi.spyOn(storage, 'backupsDir').mockResolvedValue(MANAGED);
  vi.spyOn(storage, 'pruneBackups').mockResolvedValue(0);
  // Null is the browser answer, which sends `readArchive` down its
  // `dialog.readFile` fallback and onto the fake disk above.
  vi.spyOn(storage, 'readBackup').mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backup naming', () => {
  it('does not let two backups on one day overwrite each other', () => {
    const morning = backupName(new Date(2026, 7, 5, 9, 14, 3));
    const evening = backupName(new Date(2026, 7, 5, 21, 40, 55));

    expect(morning).toBe('NotaBene-2026-08-05-091403.notabene-backup');
    expect(evening).toBe('NotaBene-2026-08-05-214055.notabene-backup');
    expect(morning).not.toBe(evening);
  });

  it('sorts chronologically by name, which is what rotation leans on', () => {
    const names = [
      backupName(new Date(2026, 7, 5, 21, 0, 0)),
      backupName(new Date(2026, 6, 5, 9, 0, 0)),
      backupName(new Date(2026, 7, 5, 9, 0, 0)),
    ];
    expect([...names].sort()).toEqual([names[1], names[2], names[0]]);
  });

  it('joins a folder and a name whichever separator the folder uses', () => {
    expect(joinPath('/Users/x/Backups', 'a.notabene-backup')).toBe(
      '/Users/x/Backups/a.notabene-backup',
    );
    expect(joinPath('/Users/x/Backups/', 'a.notabene-backup')).toBe(
      '/Users/x/Backups/a.notabene-backup',
    );
    expect(joinPath('C:\\Backups', 'a.notabene-backup')).toBe(
      'C:\\Backups\\a.notabene-backup',
    );
  });
});

describe('writing a backup', () => {
  it('reads the archive back before calling it a backup', async () => {
    await createNoteCommand({ doc: docOf('a lecture') });

    const result = await writeBackupCommand('/somewhere/backup.notabene-backup');

    expect(result.ok).toBe(true);
    expect(settings().lastBackupAt).not.toBeNull();
    expect(settings().lastBackupPath).toBe('/somewhere/backup.notabene-backup');
    expect(settings().lastBackupError).toBeNull();
  });

  it('refuses to count an unreadable archive as a backup', async () => {
    await createNoteCommand({ doc: docOf('a lecture') });
    sabotage = 'corrupt';

    const result = await writeBackupCommand('/somewhere/backup.notabene-backup');

    expect(result.ok).toBe(false);
    // The whole point: bytes reached the disk, and it still is not a backup.
    expect(disk.has('/somewhere/backup.notabene-backup')).toBe(true);
    expect(settings().lastBackupAt).toBeNull();
    expect(settings().lastBackupError).toBeTruthy();
    expect(settings().lastBackupErrorAt).toBeTruthy();
  });

  it('records a write failure where the user can see it', async () => {
    sabotage = 'fail';

    const result = await writeBackupCommand('/somewhere/backup.notabene-backup');

    expect(result.ok).toBe(false);
    expect(settings().lastBackupError).toBe('disk full');
  });

  it('clears an earlier failure once a backup succeeds', async () => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        lastBackupError: 'disk full',
        lastBackupErrorAt: '2026-08-01T09:00:00.000Z',
      },
    });

    const result = await writeBackupCommand('/somewhere/backup.notabene-backup');

    expect(result.ok).toBe(true);
    expect(settings().lastBackupError).toBeNull();
    expect(settings().lastBackupErrorAt).toBeNull();
  });
});

describe('scheduled backups', () => {
  it('writes into the folder NotaBene manages when none was chosen', async () => {
    const result = await runScheduledBackupCommand();

    expect(result).toEqual({ ok: true, value: true });
    expect([...disk.keys()][0]).toMatch(/^\/managed-backups\/NotaBene-/);
    expect(storage.pruneBackups).toHaveBeenCalledWith(DEFAULT_SETTINGS.backupsToKeep);
  });

  it('never prunes a folder the user chose', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, backupFolder: '/Users/x/Documents/Backups' },
    });

    const result = await runScheduledBackupCommand();

    expect(result).toEqual({ ok: true, value: true });
    expect([...disk.keys()][0]).toMatch(/^\/Users\/x\/Documents\/Backups\/NotaBene-/);
    expect(storage.pruneBackups).not.toHaveBeenCalled();
  });

  it('stays quiet when the interval has not elapsed', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, lastBackupAt: new Date().toISOString() },
    });

    expect(await runScheduledBackupCommand()).toEqual({ ok: true, value: false });
    expect(disk.size).toBe(0);
  });

  it('does nothing at all when the schedule is off', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, backupSchedule: 'off' },
    });

    expect(await runScheduledBackupCommand()).toEqual({ ok: true, value: false });
    expect(disk.size).toBe(0);
  });
});

describe('restoring', () => {
  /** Back up a library holding one note, then return the parsed archive. */
  async function archiveOf(text: string) {
    await createNoteCommand({ doc: docOf(text) });
    const written = await writeBackupCommand('/archive.notabene-backup');
    if (!written.ok) throw new Error(written.message);
    vi.spyOn(dialog, 'openFile').mockResolvedValue(['/archive.notabene-backup']);
    const parsed = await pickBackupCommand();
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.value;
  }

  it('saves the current library before replacing it', async () => {
    const backup = await archiveOf('the original');
    memoryLibraryAdapter.reset();
    await createNoteCommand({ doc: docOf('written since') });

    const result = await restoreBackupCommand(backup, 'replace');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.safetyPath).toMatch(
      /^\/managed-backups\/NotaBene-before-restore-/,
    );
    // The way back is a real archive, not a promise of one.
    const safety = await dialog.readFile(result.value.safetyPath!);
    expect(safety.size).toBeGreaterThan(0);
  });

  it('does not touch the library when the safety copy cannot be written', async () => {
    const backup = await archiveOf('the original');
    memoryLibraryAdapter.reset();
    await createNoteCommand({ doc: docOf('written since') });
    const before = (await library.exportLibrary()).notes;
    sabotage = 'fail';

    const result = await restoreBackupCommand(backup, 'replace');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/safety copy/i);
    // `exportedAt` is minted per call, so the notes are what "untouched" means.
    expect((await library.exportLibrary()).notes).toEqual(before);
  });

  it('refuses a safety copy that cannot be read back', async () => {
    const backup = await archiveOf('the original');
    memoryLibraryAdapter.reset();
    await createNoteCommand({ doc: docOf('written since') });
    const before = (await library.exportLibrary()).notes;
    sabotage = 'corrupt';

    const result = await restoreBackupCommand(backup, 'replace');

    expect(result.ok).toBe(false);
    expect((await library.exportLibrary()).notes).toEqual(before);
  });
});
