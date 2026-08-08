/**
 * Acting on a selection rather than a note.
 *
 * Everything here takes a list of note ids and does one thing to all of them.
 * Two rules distinguish these from a `for` loop over the single-note commands:
 *
 * 1. **One refresh, at the end.** `updateNoteCommand` re-runs the note list's
 *    query on the way out, which is right for one note and wasteful twelve
 *    times over. These call `applyNoteUpdate` and refresh once, so the list
 *    never renders a half-applied selection.
 * 2. **Partial failure is carried, not swallowed.** A selection where two
 *    notes moved and one did not is a real outcome, so it comes back in
 *    `BulkResult.failed` rather than as a plain success. No caller reads it
 *    yet — the shell has nowhere to put a "9 of 11 moved" notice, and every
 *    single-note command is voided the same way — but the result is shaped for
 *    that notice rather than needing to be reshaped for it later.
 *
 * Merge lives here too: it is the one bulk action that produces a note instead
 * of changing the ones it was given.
 */
import { library } from '@/lib/adapters';
import i18n from '@/lib/i18n';
import { mergeNoteDocs } from '@/lib/notes/mergeDocs';
import type { Note } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { applyNoteUpdate, createNoteCommand } from './noteCommands';
import { fail, ok, USER, type CommandContext, type CommandResult } from './types';

/** What a bulk write did. `failed` names the notes that did not take, ready
 * for the day the shell can say "9 of 11 moved" instead of nothing. */
export interface BulkResult {
  changed: number;
  failed: { noteId: string; message: string }[];
}

/** What the merge dialog does with the notes it consumed. */
export type MergeSourceFate = 'trash' | 'archive' | 'keep';

export interface MergeNotesInput {
  /**
   * The sources, **in the order they should appear**. The dialog seeds this
   * with `mergeOrder` and lets the student rearrange it, so honouring the list
   * exactly is what makes the preview they moved rows around in the thing that
   * actually gets written.
   */
  noteIds: string[];
  /** Overrides the default, which is the title of whichever note is on top.
   * Trimmed; an empty string falls back to that default. */
  title?: string;
  sourceFate: MergeSourceFate;
}

/**
 * The order a merge starts from: most recently edited first.
 *
 * Here rather than in the dialog so the default is one rule with one home —
 * the note you touched last is the one you are still thinking about, and it
 * should not need scrolling to reach.
 */
export function mergeOrder<T extends { updatedAt: string }>(notes: T[]): T[] {
  return [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function refreshCurrentView(): Promise<void> {
  await useLibraryStore.getState().refreshCurrentView();
}

/** Load the selection in one pass, dropping ids the library no longer has —
 * a note trashed in another window should not fail the whole action. */
async function loadNotes(noteIds: string[]): Promise<Note[]> {
  const notes: Note[] = [];
  for (const noteId of noteIds) {
    const note = await library.getNote(noteId);
    if (note) notes.push(note);
  }
  return notes;
}

/**
 * Apply the same patch to every note in a selection.
 *
 * Nothing here passes `doc` or `title`, so no snapshot is taken — filing a
 * note under a course or adding a tag is not an edit anyone would want to undo
 * from the version list, and twelve of them would bury the versions that
 * matter.
 */
async function patchEach(
  noteIds: string[],
  patch: (note: Note) => Parameters<typeof applyNoteUpdate>[0] | null,
  context: CommandContext,
): Promise<CommandResult<BulkResult>> {
  if (!noteIds.length) return fail('invalid_input', 'nothing selected');
  await useEditorStore.getState().flush();

  const notes = await loadNotes(noteIds);
  if (!notes.length) return fail('not_found', 'none of those notes exist');

  const failed: BulkResult['failed'] = [];
  let changed = 0;
  for (const note of notes) {
    const input = patch(note);
    // `null` means "already in that state" — re-tagging a note that carries
    // the tag should not bump `updatedAt` and reshuffle a date-sorted list.
    if (!input) continue;
    const result = await applyNoteUpdate(input, context);
    if (result.ok) changed += 1;
    else failed.push({ noteId: note.id, message: result.message });
  }

  await refreshCurrentView();
  return ok({ changed, failed });
}

/** File a whole selection under a course and section — the write behind
 * dropping a multi-selection on a sidebar row, and the Move action in the
 * selection bar. Section handling matches `fileNoteCommand`: crossing to a
 * different course clears a section that belongs to the old one. */
export async function fileNotesCommand(
  noteIds: string[],
  location: { courseId: string | null; sectionId?: string | null },
  context: CommandContext = USER,
): Promise<CommandResult<BulkResult>> {
  return patchEach(
    noteIds,
    (note) => {
      const sectionId =
        location.sectionId !== undefined
          ? location.sectionId
          : location.courseId === note.courseId
            ? note.sectionId
            : null;
      if (note.courseId === location.courseId && note.sectionId === sectionId) return null;
      return { noteId: note.id, courseId: location.courseId, sectionId };
    },
    context,
  );
}

export async function tagNotesCommand(
  noteIds: string[],
  tagId: string,
  mode: 'add' | 'remove',
  context: CommandContext = USER,
): Promise<CommandResult<BulkResult>> {
  return patchEach(
    noteIds,
    (note) => {
      const has = note.tagIds.includes(tagId);
      if (mode === 'add' ? has : !has) return null;
      return {
        noteId: note.id,
        tagIds: mode === 'add'
          ? [...note.tagIds, tagId]
          : note.tagIds.filter((id) => id !== tagId),
      };
    },
    context,
  );
}

export async function archiveNotesCommand(
  noteIds: string[],
  archived: boolean,
  context: CommandContext = USER,
): Promise<CommandResult<BulkResult>> {
  const result = await patchEach(
    noteIds,
    (note) => (note.archived === archived ? null : { noteId: note.id, archived }),
    context,
  );
  if (result.ok && archived) await closeAndDeselect(noteIds);
  return result;
}

export async function trashNotesCommand(
  noteIds: string[],
  _context: CommandContext = USER,
): Promise<CommandResult<BulkResult>> {
  if (!noteIds.length) return fail('invalid_input', 'nothing selected');
  await useEditorStore.getState().flush();

  const failed: BulkResult['failed'] = [];
  let changed = 0;
  for (const noteId of noteIds) {
    try {
      await library.trashNote(noteId);
      changed += 1;
    } catch (error) {
      failed.push({ noteId, message: String(error) });
    }
  }

  await closeAndDeselect(noteIds);
  await refreshCurrentView();
  return ok({ changed, failed });
}

export async function restoreNotesCommand(
  noteIds: string[],
  _context: CommandContext = USER,
): Promise<CommandResult<BulkResult>> {
  if (!noteIds.length) return fail('invalid_input', 'nothing selected');

  const failed: BulkResult['failed'] = [];
  let changed = 0;
  for (const noteId of noteIds) {
    try {
      await library.restoreNote(noteId);
      changed += 1;
    } catch (error) {
      failed.push({ noteId, message: String(error) });
    }
  }

  useUiStore.getState().clearMultiSelection();
  await refreshCurrentView();
  return ok({ changed, failed });
}

/**
 * Collect a selection into a single new note.
 *
 * `input.noteIds` is the running order, not a set — `mergeOrder` supplies the
 * default and the dialog may have rearranged it. Ids that no longer resolve
 * are dropped rather than failing the merge, which is why the order is
 * reapplied to the notes that did load.
 *
 * The new note inherits the course only when every source agreed on one —
 * the same rule `synthesizeNotesCommand` uses, and for the same reason: a
 * merge spanning three courses belongs to none of them. Tags are the union,
 * because a tag is a claim about the content, and the content is all still
 * there.
 */
export async function mergeNotesCommand(
  input: MergeNotesInput,
  context: CommandContext = USER,
): Promise<CommandResult<Note>> {
  if (input.noteIds.length < 2) {
    return fail('invalid_input', 'choose at least two notes to merge');
  }
  await useEditorStore.getState().flush();

  const notes = await loadNotes(input.noteIds);
  if (notes.length < 2) {
    return fail('not_found', 'choose at least two notes to merge');
  }

  const byId = new Map(notes.map((note) => [note.id, note]));
  const ordered = input.noteIds
    .map((noteId) => byId.get(noteId))
    .filter((note): note is Note => note !== undefined);
  const untitledLabel = i18n.t('noteList.untitled');
  const doc = mergeNoteDocs(
    ordered.map((note) => ({ title: note.title, doc: note.doc })),
    { untitledLabel },
  );

  const courseIds = new Set(ordered.map((note) => note.courseId ?? null));
  const courseId = courseIds.size === 1 ? (ordered[0]?.courseId ?? null) : null;
  const sectionIds = new Set(ordered.map((note) => note.sectionId ?? null));
  const sectionId =
    courseId && sectionIds.size === 1 ? (ordered[0]?.sectionId ?? null) : null;
  const tagIds = [...new Set(ordered.flatMap((note) => note.tagIds))];

  const created = await createNoteCommand(
    {
      title: input.title?.trim() || ordered[0]?.title || untitledLabel,
      doc,
      courseId,
      sectionId,
      tagIds,
    },
    context,
  );
  if (!created.ok) return created;

  // Only after the merged note exists. Trashing first would leave a student
  // whose disk filled up mid-write with neither the sources nor the merge.
  const sourceIds = ordered.map((note) => note.id);
  if (input.sourceFate === 'trash') await trashNotesCommand(sourceIds, context);
  else if (input.sourceFate === 'archive') {
    await archiveNotesCommand(sourceIds, true, context);
  }

  const ui = useUiStore.getState();
  ui.clearMultiSelection();
  ui.selectNote(created.value.id);
  await useEditorStore.getState().openNote(created.value.id);
  await useLibraryStore.getState().refreshTags();
  await refreshCurrentView();
  return created;
}

/** Close the editor if it is showing a note that just left the view, and drop
 * the selection that is now pointing at notes nobody can see. */
async function closeAndDeselect(noteIds: string[]): Promise<void> {
  const editor = useEditorStore.getState();
  if (editor.note && noteIds.includes(editor.note.id)) await editor.closeNote();
  const ui = useUiStore.getState();
  if (ui.selectedNoteId && noteIds.includes(ui.selectedNoteId)) ui.selectNote(null);
  else ui.clearMultiSelection();
}
