/** Smart folders and templates. Mutations stay in the command layer even
 * though both entities are small: MCP and UI callers must share validation. */
import { z } from 'zod';
import { library } from '@/lib/adapters';
import {
  newId,
  NoteDocSchema,
  NoteTemplateSchema,
  SavedSearchSchema,
  type Note,
  type NoteTemplate,
  type SavedSearch,
} from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { fail, ok, USER, type CommandContext, type CommandResult } from './types';
import { createNoteCommand } from './noteCommands';

const SavedSearchInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  query: z.string().max(1_000),
});

export async function saveSearchCommand(
  input: z.input<typeof SavedSearchInput>,
  _context: CommandContext = USER,
): Promise<CommandResult<SavedSearch>> {
  const parsed = SavedSearchInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid saved search', parsed.error.issues);
  }
  const search = SavedSearchSchema.parse({
    ...parsed.data,
    id: parsed.data.id ?? newId(),
    createdAt: new Date().toISOString(),
  });
  await library.upsertSavedSearch(search);
  await useLibraryStore.getState().refreshSavedSearches();
  return ok(search);
}

export async function deleteSavedSearchCommand(
  searchId: string,
  _context: CommandContext = USER,
): Promise<CommandResult<void>> {
  await library.deleteSavedSearch(searchId);
  await useLibraryStore.getState().refreshSavedSearches();
  return ok(undefined);
}

const TemplateInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  courseId: z.string().nullable().optional(),
  titlePattern: z.string().max(500).optional(),
  doc: NoteDocSchema,
  tagIds: z.array(z.string()).optional(),
});

export async function saveTemplateCommand(
  input: z.input<typeof TemplateInput>,
  _context: CommandContext = USER,
): Promise<CommandResult<NoteTemplate>> {
  const parsed = TemplateInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid template', parsed.error.issues);
  }
  const template = NoteTemplateSchema.parse({
    ...parsed.data,
    id: parsed.data.id ?? newId(),
    courseId: parsed.data.courseId ?? null,
    titlePattern: parsed.data.titlePattern ?? '',
    tagIds: parsed.data.tagIds ?? [],
  });
  await library.upsertTemplate(template);
  await useLibraryStore.getState().refreshTemplates();
  return ok(template);
}

export async function saveNoteAsTemplateCommand(
  note: Note,
  name: string,
  global: boolean,
  context: CommandContext = USER,
): Promise<CommandResult<NoteTemplate>> {
  return saveTemplateCommand(
    {
      name,
      courseId: global ? null : note.courseId,
      titlePattern: note.title,
      doc: note.doc,
      tagIds: note.tagIds,
    },
    context,
  );
}

export async function createNoteFromTemplateCommand(
  template: NoteTemplate,
  context: CommandContext = USER,
) {
  return createNoteCommand(
    {
      title: expandTitlePattern(template.titlePattern),
      courseId: template.courseId,
      doc: template.doc,
      tagIds: template.tagIds,
    },
    context,
  );
}

export async function deleteTemplateCommand(
  templateId: string,
  _context: CommandContext = USER,
): Promise<CommandResult<void>> {
  await library.deleteTemplate(templateId);
  await useLibraryStore.getState().refreshTemplates();
  return ok(undefined);
}

function expandTitlePattern(pattern: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return pattern.replaceAll('{{date}}', today);
}
