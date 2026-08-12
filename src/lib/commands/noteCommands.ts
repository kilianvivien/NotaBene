/**
 * Note mutations.
 *
 * Every function here does the same four things, in the same order: validate
 * the input against the schema, snapshot when the change is destructive enough
 * to want an undo point, write through the adapter, then refresh the read
 * caches. Callers — the editor, the AI diff panel, the MCP bridge — get a
 * `CommandResult` and never touch `library` directly.
 */
import { z } from 'zod';
import { assets, library } from '@/lib/adapters';
import {
  createNote,
  NoteDocSchema,
  type Note,
  type NoteDoc,
  type NoteSummary,
  type SnapshotCause,
} from '@/lib/schema';
import { deriveTitle, flattenDoc } from '@/lib/notes/docText';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { SNAPSHOT_RETENTION_POLICIES } from '@/lib/history/retention';
import {
  cancelledIfRequested,
  fail,
  ok,
  USER,
  type CommandContext,
  type CommandResult,
} from './types';

const CreateNoteInput = z.object({
  title: z.string().max(500).optional(),
  courseId: z.string().nullable().optional(),
  sectionId: z.string().nullable().optional(),
  doc: NoteDocSchema.optional(),
  tagIds: z.array(z.string()).optional(),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;

const UpdateNoteInput = z.object({
  noteId: z.string().min(1),
  /** Optimistic-concurrency guard used by external writers. When supplied,
   * the write only lands if the note is still the version the caller read. */
  baseUpdatedAt: z.string().datetime().optional(),
  title: z.string().max(500).optional(),
  doc: NoteDocSchema.optional(),
  courseId: z.string().nullable().optional(),
  sectionId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateNoteInput = z.infer<typeof UpdateNoteInput>;

/** Snapshot cause implied by who is asking. */
function causeFor(context: CommandContext): SnapshotCause {
  if (context.snapshotCause) return context.snapshotCause;
  switch (context.source) {
    case 'ai':
      return 'ai';
    case 'agent':
      return 'agent';
    default:
      return 'session';
  }
}

/** Re-run whichever query the note list is showing — not a hardcoded one, or
 * creating a note inside a course would kick the list back to "all notes". */
async function refreshCurrentView(): Promise<void> {
  await useLibraryStore.getState().refreshCurrentView();
}

/**
 * A read, not a mutation — and deliberately not `libraryStore.refreshNotes`.
 *
 * The command palette searches while you type, and `refreshNotes` replaces the
 * note list the palette is floating over. Typing three letters would leave the
 * app showing the results of a search the user abandoned as soon as they picked
 * something. This returns results and touches no state at all.
 */
export async function searchNotesCommand(
  text: string,
  limit = 8,
): Promise<CommandResult<NoteSummary[]>> {
  const query = text.trim();
  if (!query) return ok([]);
  try {
    return ok(
      await library.queryNotes({ text: query, scope: 'live', sort: 'relevance', limit }),
    );
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function createNoteCommand(
  input: CreateNoteInput,
  context: CommandContext = USER,
): Promise<CommandResult<Note>> {
  const cancelled = cancelledIfRequested<Note>(context);
  if (cancelled) return cancelled;
  const parsed = CreateNoteInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid note input', parsed.error.issues);
  }

  const doc: NoteDoc = parsed.data.doc ?? {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  };
  const note = createNote({
    ...parsed.data,
    doc,
    plainText: flattenDoc(doc),
    title: parsed.data.title ?? deriveTitle(doc, ''),
  });

  try {
    const stopped = cancelledIfRequested<Note>(context);
    if (stopped) return stopped;
    await library.upsertNote(note);
  } catch (error) {
    return fail('storage_failed', String(error));
  }

  // The note is already durable. A stale read cache can repair itself on the
  // next query; reporting the creation as failed would invite a retry and a
  // duplicate note, and would hide the created id from whole-run undo.
  await refreshCurrentView().catch(() => {});
  return ok(note);
}

export async function updateNoteCommand(
  input: UpdateNoteInput,
  context: CommandContext = USER,
): Promise<CommandResult<Note>> {
  const result = await applyNoteUpdate(input, context);
  await refreshCurrentView();
  return result;
}

/**
 * `updateNoteCommand` without the read-cache refresh.
 *
 * Exported for `bulkCommands`, which writes a whole selection and then
 * refreshes once. Looping the public command instead would re-run the note
 * list's query — and every course, tag and count behind it — for each of
 * twelve notes, and the intermediate states are ones nobody ever sees.
 */
export async function applyNoteUpdate(
  input: UpdateNoteInput,
  context: CommandContext = USER,
): Promise<CommandResult<Note>> {
  const cancelled = cancelledIfRequested<Note>(context);
  if (cancelled) return cancelled;
  const parsed = UpdateNoteInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid note input', parsed.error.issues);
  }

  const existing = await library.getNote(parsed.data.noteId);
  if (!existing) return fail('not_found', `no note ${parsed.data.noteId}`);
  // Snapshot *before* the write, so the history entry is the state the user
  // would want back. Only content changes deserve one; toggling `pinned`
  // should not fill the version list with noise.
  const contentChanged =
    parsed.data.doc !== undefined ||
    parsed.data.title !== undefined ||
    context.source === 'agent';
  if (contentChanged) {
    try {
      await library.createSnapshot(existing.id, causeFor(context), context.agentRunId);
    } catch {
      // A failed snapshot must not block the edit — losing an undo point is
      // recoverable, refusing to save the student's typing is not.
    }
  }
  const cancelledAfterSnapshot = cancelledIfRequested<Note>(context);
  if (cancelledAfterSnapshot) return cancelledAfterSnapshot;

  // `noteId` addresses the note; it is not a field on it.
  // Optional fields passed explicitly as `undefined` must not overwrite the
  // persisted value. MCP handlers naturally construct objects that contain
  // those keys, and object spread would otherwise turn a partial update into
  // a malformed note.
  const patch: Partial<
    Pick<
      Note,
      'title' | 'doc' | 'courseId' | 'sectionId' | 'tagIds' | 'pinned' | 'archived'
    >
  > = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.doc !== undefined) patch.doc = parsed.data.doc;
  if (parsed.data.courseId !== undefined) patch.courseId = parsed.data.courseId;
  if (parsed.data.sectionId !== undefined) patch.sectionId = parsed.data.sectionId;
  if (parsed.data.tagIds !== undefined) patch.tagIds = parsed.data.tagIds;
  if (parsed.data.pinned !== undefined) patch.pinned = parsed.data.pinned;
  if (parsed.data.archived !== undefined) patch.archived = parsed.data.archived;
  const doc = patch.doc ?? existing.doc;
  const updated: Note = {
    ...existing,
    ...patch,
    doc,
    plainText: flattenDoc(doc),
    updatedAt: new Date().toISOString(),
  };

  try {
    const baseUpdatedAt = parsed.data.baseUpdatedAt ?? existing.updatedAt;
    const saved = await library.upsertNoteIfUnchanged(updated, baseUpdatedAt);
    if (!saved) {
      const current = await library.getNote(existing.id);
      return fail('conflict', 'the note changed after it was read', {
        expectedUpdatedAt: baseUpdatedAt,
        actualUpdatedAt: current?.updatedAt,
      });
    }
  } catch (error) {
    return fail('storage_failed', String(error));
  }
  const retention = useSettingsStore.getState().settings.snapshotRetention;
  void library
    .pruneSnapshots(existing.id, SNAPSHOT_RETENTION_POLICIES[retention])
    .catch(() => {
      // Retention is housekeeping. A saved edit must stay successful if
      // thinning old versions fails; the safe failure mode is keeping more.
    });

  // Keep an open editor in step with a write that came from somewhere else.
  const editor = useEditorStore.getState();
  if (editor.note?.id === updated.id && context.source !== 'user') {
    await editor.openNote(updated.id);
  }

  return ok(updated);
}

export async function purgeExpiredTrashCommand(
  retentionDays = useSettingsStore.getState().settings.trashRetentionDays,
): Promise<CommandResult<number>> {
  const cutoff = new Date(Date.now() - Math.max(0, retentionDays) * 86_400_000);
  try {
    const removed = await library.purgeTrash(cutoff.toISOString());
    await collectAssetGarbageCommand();
    await refreshCurrentView();
    return ok(removed);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

export async function emptyTrashCommand(): Promise<CommandResult<number>> {
  try {
    const removed = await library.purgeTrash(new Date().toISOString());
    await collectAssetGarbageCommand();
    const editor = useEditorStore.getState();
    if (editor.note?.trashedAt) await editor.closeNote();
    useUiStore.getState().selectNote(null);
    await refreshCurrentView();
    return ok(removed);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

/** Reclaim content-addressed blobs no note, version, template, journal row or
 * attachment can reach. The desktop adapter computes reachability atomically. */
export async function collectAssetGarbageCommand(): Promise<
  CommandResult<{ removed: number; bytes: number }>
> {
  try {
    const result = await assets.collectGarbage();
    if (result.removed > 0) {
      await useSettingsStore.getState().update({
        lastAssetReclaimedBytes: result.bytes,
        lastAssetReclaimedAt: new Date().toISOString(),
      });
    }
    return ok(result);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

/**
 * File a note under a course and section — the write behind dropping a note on
 * a sidebar row.
 *
 * Moving to a different course clears the section, because a section belongs to
 * exactly one course and carrying the old id across would leave the note
 * pointing at a section its new course has never heard of.
 */
export async function fileNoteCommand(
  noteId: string,
  location: { courseId: string | null; sectionId?: string | null },
  context: CommandContext = USER,
): Promise<CommandResult<Note>> {
  const existing = await library.getNote(noteId);
  if (!existing) return fail('not_found', `no note ${noteId}`);

  const sectionId =
    location.sectionId !== undefined
      ? location.sectionId
      : location.courseId === existing.courseId
        ? existing.sectionId
        : null;

  if (existing.courseId === location.courseId && existing.sectionId === sectionId) {
    return ok(existing);
  }

  await useEditorStore.getState().flush();
  return updateNoteCommand({ noteId, courseId: location.courseId, sectionId }, context);
}

export async function trashNoteCommand(
  noteId: string,
  _context: CommandContext = USER,
): Promise<CommandResult<void>> {
  const existing = await library.getNote(noteId);
  if (!existing) return fail('not_found', `no note ${noteId}`);

  await library.trashNote(noteId);
  const editor = useEditorStore.getState();
  if (editor.note?.id === noteId) await editor.closeNote();

  await refreshCurrentView();
  return ok(undefined);
}

export async function restoreNoteCommand(
  noteId: string,
  _context: CommandContext = USER,
): Promise<CommandResult<void>> {
  await library.restoreNote(noteId);
  await refreshCurrentView();
  return ok(undefined);
}

export async function reorderNotesCommand(
  orderedIds: string[],
  _context: CommandContext = USER,
): Promise<CommandResult<void>> {
  await useEditorStore.getState().flush();
  for (const [order, noteId] of orderedIds.entries()) {
    const note = await library.getNote(noteId);
    if (note) await library.upsertNote({ ...note, order });
  }
  await refreshCurrentView();
  return ok(undefined);
}

/**
 * Roll a note back to an earlier snapshot. Restoring writes a *new* version
 * rather than rewinding history, so a mistaken restore is itself undoable
 * (PRD §5.4).
 */
export async function restoreSnapshotCommand(
  snapshotId: string,
  context: CommandContext = USER,
): Promise<CommandResult<Note>> {
  const snapshot = await library.getSnapshot(snapshotId);
  if (!snapshot) return fail('not_found', `no snapshot ${snapshotId}`);

  return updateNoteCommand(
    { noteId: snapshot.noteId, doc: snapshot.doc, title: snapshot.title },
    { ...context, snapshotCause: 'restore' },
  );
}
