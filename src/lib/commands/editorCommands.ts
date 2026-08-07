import { library } from '@/lib/adapters';
import { SNAPSHOT_RETENTION_POLICIES } from '@/lib/history/retention';
import { NoteSchema, type Note, type SnapshotCause } from '@/lib/schema';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { fail, ok, type CommandResult } from './types';

/**
 * Persist the editor's debounced state through the command boundary.
 *
 * The snapshot is taken before the write. `session` captures the state that
 * was opened; later `auto` entries capture the last durable state at the
 * ten-minute cadence.
 */
export async function saveEditorNoteCommand(
  note: Note,
  snapshotCause: SnapshotCause | null,
  baseUpdatedAt: string,
): Promise<CommandResult<Note>> {
  const parsed = NoteSchema.safeParse(note);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid editor note', parsed.error.issues);
  }
  if (snapshotCause) {
    try {
      await library.createSnapshot(note.id, snapshotCause);
    } catch {
      // A failed history write must never block the durable autosave.
    }
  }
  try {
    const saved = await library.upsertNoteIfUnchanged(parsed.data, baseUpdatedAt);
    if (!saved) {
      return fail('conflict', 'this note changed elsewhere');
    }
    const retention = useSettingsStore.getState().settings.snapshotRetention;
    void library
      .pruneSnapshots(note.id, SNAPSHOT_RETENTION_POLICIES[retention])
      .catch(() => {
        // Keeping extra history is the safe failure mode.
      });
    return ok(parsed.data);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

/** Explicit conflict resolution only. Preserve the durable version, then let
 * the student's chosen editor copy become current via the unconditional path. */
export async function keepEditorVersionCommand(note: Note): Promise<CommandResult<Note>> {
  const parsed = NoteSchema.safeParse({
    ...note,
    updatedAt: new Date().toISOString(),
  });
  if (!parsed.success) return fail('invalid_input', 'invalid editor note');
  try {
    await library.createSnapshot(note.id, 'session');
    await library.upsertNote(parsed.data);
    return ok(parsed.data);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}
