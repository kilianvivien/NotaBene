/**
 * Read-side command façade.
 *
 * Reads do not need the mutation guarantees of the rest of the command layer,
 * but keeping them here means MCP handlers never reach through the application
 * boundary to an adapter. UI and agent callers therefore share the same error
 * vocabulary and query semantics.
 */
import { library, type NoteQuery } from '@/lib/adapters';
import type {
  Attachment,
  Course,
  Note,
  NoteMatch,
  NoteSummary,
  Section,
  Snapshot,
  Tag,
} from '@/lib/schema';
import { extractDocumentCommand } from './importCommands';
import { fail, ok, type CommandResult } from './types';

async function read<T>(operation: () => Promise<T>): Promise<CommandResult<T>> {
  try {
    return ok(await operation());
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

export function listCoursesCommand(): Promise<CommandResult<Course[]>> {
  return read(() => library.listCourses());
}

export function listSectionsCommand(courseId: string): Promise<CommandResult<Section[]>> {
  return read(() => library.listSections(courseId));
}

export function listTagsCommand(): Promise<CommandResult<Tag[]>> {
  return read(() => library.listTags());
}

export function queryNotesCommand(
  query: NoteQuery,
): Promise<CommandResult<NoteSummary[]>> {
  return read(() => library.queryNotes(query));
}

/**
 * Ranked search. Unlike `queryNotesCommand` this orders by relevance alone and
 * hands back a score, which is what retrieval fuses with its other signals.
 *
 * Named for what distinguishes it — `searchNotesCommand` in `noteCommands.ts`
 * is the command palette's text-to-summaries helper, and it is not this.
 */
export function rankNotesCommand(query: NoteQuery): Promise<CommandResult<NoteMatch[]>> {
  return read(() => library.searchNotes(query));
}

export async function readNoteCommand(noteId: string): Promise<CommandResult<Note>> {
  const result = await read(() => library.getNote(noteId));
  if (!result.ok) return result;
  return result.value ? ok(result.value) : fail('not_found', `no note ${noteId}`);
}

export function listAttachmentsCommand(
  noteId: string,
): Promise<CommandResult<Attachment[]>> {
  return read(() => library.listAttachments(noteId));
}

/** A note's saved versions, newest first, without their bodies. */
export function listSnapshotsCommand(
  noteId: string,
): Promise<CommandResult<Omit<Snapshot, 'doc'>[]>> {
  return read(() => library.listSnapshots(noteId));
}

export async function readSnapshotCommand(
  snapshotId: string,
): Promise<CommandResult<Snapshot>> {
  const result = await read(() => library.getSnapshot(snapshotId));
  if (!result.ok) return result;
  return result.value ? ok(result.value) : fail('not_found', `no snapshot ${snapshotId}`);
}

/**
 * The text of an attachment, through the same extraction document import
 * uses — never a second parser.
 *
 * Kept for a few documents because an agent pages through a long PDF one
 * call at a time, and converting eighty pages again for every page of it is
 * the slow part. Keyed by asset, which is content-addressed and immutable, so
 * an entry can never describe bytes that have since changed.
 */
export async function attachmentTextCommand(
  attachment: Attachment,
): Promise<CommandResult<string>> {
  const cached = attachmentText.get(attachment.assetId);
  if (cached !== undefined) {
    attachmentText.delete(attachment.assetId);
    attachmentText.set(attachment.assetId, cached);
    return ok(cached);
  }
  const extracted = await extractDocumentCommand({ kind: 'attachment', attachment });
  if (!extracted.ok) return extracted;
  const text = extracted.value.markdown;
  attachmentText.set(attachment.assetId, text);
  while (attachmentText.size > MAX_CACHED_ATTACHMENTS) {
    attachmentText.delete(attachmentText.keys().next().value!);
  }
  return ok(text);
}

const MAX_CACHED_ATTACHMENTS = 6;
const attachmentText = new Map<string, string>();
