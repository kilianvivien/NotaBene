/** Courses, sections, and tags — the shape of the library rather than its
 * contents. Same contract as `noteCommands`: validate, write, refresh. */
import { z } from 'zod';
import { library } from '@/lib/adapters';
import {
  COURSE_COLORS,
  createCourse,
  createSection,
  newId,
  TAG_NAMESPACES,
  type Course,
  type Section,
  type Tag,
} from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { fail, ok, USER, type CommandContext, type CommandResult } from './types';

const CreateCourseInput = z.object({
  name: z.string().min(1).max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(8).optional(),
  professor: z.string().max(200).optional(),
  semester: z.string().max(100).optional(),
});
export type CreateCourseInput = z.infer<typeof CreateCourseInput>;

export async function createCourseCommand(
  input: CreateCourseInput,
  _context: CommandContext = USER,
): Promise<CommandResult<Course>> {
  const parsed = CreateCourseInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid course input', parsed.error.issues);
  }

  const existing = await library.listCourses();
  const course = createCourse({
    ...parsed.data,
    // Cycle the palette so a new course never lands on the same colour as the
    // one above it in the sidebar.
    color: parsed.data.color ?? COURSE_COLORS[existing.length % COURSE_COLORS.length],
    order: existing.length,
  });

  await library.upsertCourse(course);
  await useLibraryStore.getState().refreshCourses();
  return ok(course);
}

export async function updateCourseCommand(
  course: Course,
  _context: CommandContext = USER,
): Promise<CommandResult<Course>> {
  const updated = { ...course, updatedAt: new Date().toISOString() };
  await library.upsertCourse(updated);
  await useLibraryStore.getState().refreshCourses();
  return ok(updated);
}

export async function createSectionCommand(
  input: { courseId: string; name: string },
  _context: CommandContext = USER,
): Promise<CommandResult<Section>> {
  if (!input.name.trim()) return fail('invalid_input', 'section name is required');

  const siblings = await library.listSections(input.courseId);
  const section = createSection({ ...input, order: siblings.length });
  await library.upsertSection(section);
  await useLibraryStore.getState().refreshSections(input.courseId);
  return ok(section);
}

const TagInput = z.object({
  name: z.string().min(1).max(100),
  namespace: z.enum(TAG_NAMESPACES).nullable().optional(),
});

/**
 * Get-or-create a tag. Tags are global and matched case-insensitively within a
 * namespace, so `topic:Calculus` and `topic:calculus` stay one tag rather than
 * quietly splitting a student's filters in two.
 */
export async function ensureTagCommand(
  input: z.input<typeof TagInput>,
  _context: CommandContext = USER,
): Promise<CommandResult<Tag>> {
  const parsed = TagInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid tag input', parsed.error.issues);
  }

  const namespace = parsed.data.namespace ?? null;
  const existing = await library.listTags();
  const match = existing.find(
    (tag) =>
      tag.namespace === namespace &&
      tag.name.localeCompare(parsed.data.name, undefined, { sensitivity: 'accent' }) === 0,
  );
  if (match) return ok(match);

  const tag: Tag = { id: newId(), namespace, name: parsed.data.name };
  await library.upsertTag(tag);
  await useLibraryStore.getState().refreshTags();
  return ok(tag);
}

export async function mergeTagsCommand(
  fromTagId: string,
  intoTagId: string,
  _context: CommandContext = USER,
): Promise<CommandResult<void>> {
  if (fromTagId === intoTagId) return fail('invalid_input', 'cannot merge a tag into itself');
  await library.mergeTags(fromTagId, intoTagId);
  await useLibraryStore.getState().refreshTags();
  return ok(undefined);
}
