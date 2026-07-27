import { describe, expect, it } from 'vitest';
import {
  createNote,
  emptyLibrary,
  MindMapSchema,
  NoteSchema,
  safeImportLibrary,
  SCHEMA_VERSION,
} from './index';

describe('library import', () => {
  it('round-trips an empty library', () => {
    const result = safeImportLibrary(emptyLibrary());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migratedFrom).toBe(SCHEMA_VERSION);
  });

  it('refuses a library from a newer build rather than guessing', () => {
    const result = safeImportLibrary({ ...emptyLibrary(), schemaVersion: SCHEMA_VERSION + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/newer NotaBene/);
  });

  it('rejects a library with a malformed note instead of throwing', () => {
    const library = emptyLibrary();
    // @ts-expect-error deliberately invalid: `doc` must be a document node.
    library.notes.push({ ...createNote({ title: 'broken' }), doc: 'not a doc' });

    const result = safeImportLibrary(library);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues?.length).toBeGreaterThan(0);
  });

  it('names the failing path so the restore dialog can be specific', () => {
    // Collections default to empty, but a backup with no `exportedAt` is not a
    // backup we should trust — and the caller is told exactly which field.
    const result = safeImportLibrary({ schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues?.[0]).toMatch(/^exportedAt:/);
  });
});

describe('note schema', () => {
  it('fills in defaults for a minimal note', () => {
    const parsed = NoteSchema.parse({
      id: 'n1',
      doc: { type: 'doc', content: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(parsed.courseId).toBeNull();
    expect(parsed.pinned).toBe(false);
    expect(parsed.tagIds).toEqual([]);
  });
});

describe('mind map schema', () => {
  it('accepts a graph whose edges all resolve', () => {
    const parsed = MindMapSchema.safeParse({
      title: 'Derivatives',
      nodes: [
        { id: 'a', label: 'Chain rule' },
        { id: 'b', label: 'Product rule' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an edge pointing at a node the model invented', () => {
    const parsed = MindMapSchema.safeParse({
      title: 'Derivatives',
      nodes: [{ id: 'a', label: 'Chain rule' }],
      edges: [{ from: 'a', to: 'ghost' }],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toMatch(/unknown node/);
    }
  });
});
