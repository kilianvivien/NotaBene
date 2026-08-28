import { describe, expect, it } from 'vitest';
import {
  AiDiagramResponseSchema,
  createNote,
  emptyLibrary,
  MindMapSchema,
  NoteSchema,
  safeImportLibrary,
  SCHEMA_VERSION,
  TaskSchema,
} from './index';

describe('library import', () => {
  it('round-trips long-form document metadata without a library schema migration', () => {
    const library = emptyLibrary();
    library.notes.push(
      createNote({
        doc: {
          type: 'doc',
          attrs: { writingTarget: 12_000 },
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Claim' },
                {
                  type: 'footnote',
                  attrs: { id: 'source', kind: 'footnote', note: 'Source text' },
                },
              ],
            },
          ],
        },
      }),
    );
    const result = safeImportLibrary(library);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.library.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result.library.notes[0]?.doc.attrs).toEqual({ writingTarget: 12_000 });
      expect(result.library.notes[0]?.doc.content[0]?.content?.[1]?.type).toBe(
        'footnote',
      );
    }
  });

  it('round-trips an empty library', () => {
    const result = safeImportLibrary(emptyLibrary());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migratedFrom).toBe(SCHEMA_VERSION);
  });

  it('refuses a library from a newer build rather than guessing', () => {
    const result = safeImportLibrary({
      ...emptyLibrary(),
      schemaVersion: SCHEMA_VERSION + 1,
    });
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

  it('adds the default tag color when importing a v2 library', () => {
    const library = {
      ...emptyLibrary(),
      schemaVersion: 2,
      tags: [{ id: 'tag-1', namespace: null, name: 'Important' }],
    };
    const result = safeImportLibrary(library);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.library.tags[0]?.color).toBe('#9b5c2f');
  });

  it('marks pre-agent snapshots as belonging to no run when importing v3', () => {
    const library = {
      ...emptyLibrary(),
      schemaVersion: 3,
      snapshots: [
        {
          id: 'snapshot-1',
          noteId: 'note-1',
          doc: { type: 'doc', content: [] },
          title: 'Before',
          cause: 'session',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const result = safeImportLibrary(library);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.library.snapshots[0]?.runId).toBeNull();
  });

  it('adds an empty PDF annotation layer when importing a v4 library', () => {
    const library = {
      ...emptyLibrary(),
      schemaVersion: 4,
      attachments: [
        {
          id: 'attachment-1',
          noteId: 'note-1',
          assetId: 'asset-1',
          name: 'paper.pdf',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const result = safeImportLibrary(library);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.library.attachments[0]?.annotations).toEqual([]);
  });

  it('marks pre-web-link attachments as coming from no page when importing v6', () => {
    const library = {
      ...emptyLibrary(),
      schemaVersion: 6,
      attachments: [
        {
          id: 'attachment-1',
          noteId: 'note-1',
          assetId: 'asset-1',
          name: 'paper.pdf',
          createdAt: new Date().toISOString(),
          annotations: [],
        },
      ],
    };
    const result = safeImportLibrary(library);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.library.attachments[0]?.url).toBeNull();
      expect(result.library.attachments[0]?.fetchedAt).toBeNull();
    }
  });

  it('gives a v5 library empty task collections rather than refusing it', () => {
    const { tasks: _tasks, taskNoteLinks: _links, ...v5 } = emptyLibrary();
    const result = safeImportLibrary({ ...v5, schemaVersion: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.library.tasks).toEqual([]);
      expect(result.library.taskNoteLinks).toEqual([]);
      expect(result.library.schemaVersion).toBe(SCHEMA_VERSION);
    }
  });
});

describe('task schema', () => {
  it('fills in defaults for a minimal task', () => {
    const parsed = TaskSchema.parse({
      id: 't1',
      title: 'Problem set 3',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(parsed.status).toBe('todo');
    expect(parsed.priority).toBe('none');
    expect(parsed.courseId).toBeNull();
    expect(parsed.parentId).toBeNull();
    expect(parsed.recurrence).toBeNull();
    expect(parsed.trashedAt).toBeNull();
  });

  it('refuses a task with no title, because a blank row is not a to-do', () => {
    const result = TaskSchema.safeParse({
      id: 't1',
      title: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('keeps a weekly recurrence with its weekdays', () => {
    const parsed = TaskSchema.parse({
      id: 't1',
      title: 'Lab report',
      recurrence: { freq: 'weekly', interval: 2, weekdays: [2, 4] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(parsed.recurrence).toEqual({ freq: 'weekly', interval: 2, weekdays: [2, 4] });
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
      expect(parsed.error.issues[0]?.message).toMatch(/unknown node/);
    }
  });
});

describe('AI diagram schema', () => {
  const valid = {
    title: 'Photosynthesis',
    kind: 'flowchart',
    mermaid: 'flowchart TD\n  A[Light] --> B[Glucose]',
  };

  it('accepts the kinds that convert to editable elements', () => {
    for (const kind of ['flowchart', 'sequence']) {
      expect(AiDiagramResponseSchema.safeParse({ ...valid, kind }).success).toBe(true);
    }
  });

  /**
   * The point of the enum. Each of these is valid Mermaid and the converter
   * accepts every one — by rasterising it into the scene, which is the single
   * outcome this feature exists to avoid. `class` is on the list because
   * Excalidraw's own dialog claims it is supported and, measured, it is not.
   */
  it('rejects a diagram type that would arrive as a flat image', () => {
    for (const kind of ['class', 'gantt', 'erDiagram', 'pie', 'stateDiagram']) {
      expect(AiDiagramResponseSchema.safeParse({ ...valid, kind }).success).toBe(false);
    }
  });

  it('rejects an empty diagram, whitespace included', () => {
    expect(AiDiagramResponseSchema.safeParse({ ...valid, mermaid: '' }).success).toBe(
      false,
    );
    expect(AiDiagramResponseSchema.safeParse({ ...valid, mermaid: '   ' }).success).toBe(
      false,
    );
    expect(AiDiagramResponseSchema.safeParse({ ...valid, title: '  ' }).success).toBe(
      false,
    );
  });
});
