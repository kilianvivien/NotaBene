/**
 * Crash recovery.
 *
 * The editor journals in-flight state ahead of every save (`editorStore.ts`).
 * If the app dies between the two, the row outlives the note it belongs to and
 * is offered back here. Recovering is an ordinary edit — it goes through
 * `updateNoteCommand`, so the version the user is replacing lands in history
 * first and a mistaken recovery is itself undoable.
 */
import { library } from '@/lib/adapters';
import type { Note, PendingRecovery } from '@/lib/schema';
import { updateNoteCommand } from './noteCommands';
import { fail, ok, USER, type CommandContext, type CommandResult } from './types';

export async function recoverJournalCommand(
  noteId: string,
  context: CommandContext = USER,
): Promise<CommandResult<Note>> {
  const pending = await library.pendingRecoveries();
  const entry = pending.find((candidate) => candidate.noteId === noteId);
  if (!entry) return fail('not_found', `no recoverable edits for note ${noteId}`);

  const result = await updateNoteCommand(
    { noteId: entry.noteId, doc: entry.doc, title: entry.title },
    context,
  );
  // Only clear the journal once the recovered text is safely written. Leaving
  // the row on failure means the offer comes back next launch instead of the
  // work disappearing twice.
  if (result.ok) await library.discardJournal(noteId);
  return result;
}

/** Keep the saved version and throw the unsaved tail away. */
export async function discardJournalCommand(
  noteId: string,
  _context: CommandContext = USER,
): Promise<CommandResult<void>> {
  await library.discardJournal(noteId);
  return ok(undefined);
}

export type { PendingRecovery };
