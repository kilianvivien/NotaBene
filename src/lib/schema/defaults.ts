/** Constructors for fresh entities. Keeping them here means ids, timestamps,
 * and default shapes are minted one way everywhere — including from the MCP
 * command path, where nothing else would supply them. */
import { nanoid } from 'nanoid';
import {
  SCHEMA_VERSION,
  type Course,
  type Library,
  type Note,
  type NoteDoc,
  type Section,
} from './schema';

export const COURSE_COLORS = [
  '#007aff',
  '#ff375f',
  '#ff9f0a',
  '#30d158',
  '#bf5af2',
  '#64d2ff',
  '#ff6482',
  '#ffd60a',
] as const;

export function newId(): string {
  return nanoid(12);
}

function now(): string {
  return new Date().toISOString();
}

export function emptyDoc(): NoteDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export function createCourse(input: Partial<Course> & { name: string }): Course {
  const timestamp = now();
  return {
    id: input.id ?? newId(),
    name: input.name,
    color: input.color ?? COURSE_COLORS[0],
    icon: input.icon ?? '📘',
    professor: input.professor,
    semester: input.semester,
    credits: input.credits,
    schedule: input.schedule,
    order: input.order ?? 0,
    archived: input.archived ?? false,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  };
}

export function createSection(input: Partial<Section> & { courseId: string; name: string }): Section {
  return {
    id: input.id ?? newId(),
    courseId: input.courseId,
    name: input.name,
    order: input.order ?? 0,
  };
}

export function createNote(input: Partial<Note> = {}): Note {
  const timestamp = now();
  return {
    id: input.id ?? newId(),
    courseId: input.courseId ?? null,
    sectionId: input.sectionId ?? null,
    title: input.title ?? '',
    doc: input.doc ?? emptyDoc(),
    plainText: input.plainText ?? '',
    tagIds: input.tagIds ?? [],
    pinned: input.pinned ?? false,
    archived: input.archived ?? false,
    trashedAt: input.trashedAt ?? null,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    order: input.order ?? 0,
  };
}

export function emptyLibrary(appVersion = '0.3.2'): Library {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now(),
    appVersion,
    courses: [],
    sections: [],
    notes: [],
    tags: [],
    assets: [],
    attachments: [],
    snapshots: [],
    savedSearches: [],
    templates: [],
  };
}
