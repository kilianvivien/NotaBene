/**
 * Read-side command façade.
 *
 * Reads do not need the mutation guarantees of the rest of the command layer,
 * but keeping them here means MCP handlers never reach through the application
 * boundary to an adapter. UI and agent callers therefore share the same error
 * vocabulary and query semantics.
 */
import { library, type NoteQuery } from '@/lib/adapters';
import type { Course, Note, NoteMatch, NoteSummary, Section, Tag } from '@/lib/schema';
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
