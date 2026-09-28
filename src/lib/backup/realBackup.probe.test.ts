/**
 * A real backup through the real restore path, on demand (plan §8's
 * *Verification*: "a 1.1.0 backup … migrates, notes intact, a v9 backup
 * restores").
 *
 * Skipped unless `NB_BACKUP_PROBE` names a `.notabene-backup`. Restores into
 * the in-memory library, never the student's own, and prints counts only —
 * a backup is somebody's notes.
 *
 *   NB_BACKUP_PROBE=~/Library/…/backups/NotaBene-….notabene-backup \
 *     pnpm vitest run src/lib/backup/realBackup.probe.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { SCHEMA_VERSION } from '@/lib/schema';
import { createBackupArchive, parseBackupArchive } from './index';

const path = process.env.NB_BACKUP_PROBE;

describe.skipIf(!path)('a real backup', () => {
  it('restores, keeps every note, and round-trips as a current backup', async () => {
    const bytes = readFileSync(path!);
    const parsed = await parseBackupArchive(new Blob([bytes]));
    const from = parsed.manifest.schemaVersion;
    const counts = (library: typeof parsed.library) => ({
      notes: library.notes.length,
      courses: library.courses.length,
      tags: library.tags.length,
      tasks: library.tasks.length,
      attachments: library.attachments.length,
      snapshots: library.snapshots.length,
    });

    memoryLibraryAdapter.reset();
    await memoryLibraryAdapter.importLibrary(parsed.library, 'replace');
    const restored = await memoryLibraryAdapter.exportLibrary();
    expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(counts(restored)).toEqual(counts(parsed.library));
    for (const note of parsed.library.notes) {
      const back = restored.notes.find((entry) => entry.id === note.id);
      expect(back?.doc).toEqual(note.doc);
      expect(back?.title).toBe(note.title);
    }

    // What 1.2 writes, read back by 1.2.
    const { blob } = await createBackupArchive(restored);
    const again = await parseBackupArchive(blob);
    expect(counts(again.library)).toEqual(counts(parsed.library));

    if (process.env.NB_BACKUP_PROBE_OUT) {
      writeFileSync(process.env.NB_BACKUP_PROBE_OUT, JSON.stringify(again.library));
    }
    // Straight to stdout: the test setup quiets `console`.
    process.stdout.write(
      `backup schema v${from} → v${SCHEMA_VERSION}: ${JSON.stringify(counts(parsed.library))}\n`,
    );
  });
});
