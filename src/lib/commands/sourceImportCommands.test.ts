import { beforeEach, describe, expect, it } from 'vitest';
import { library } from '@/lib/adapters';
import { createMemoryFolderImportAdapter } from '@/lib/adapters/folderImport/memoryFolderImportAdapter';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createFolderSource } from '@/lib/import/sources/folderSource';
import type { SourceScan } from '@/lib/import/sources';
import type { DocNode, Note } from '@/lib/schema';
import {
  applySourceImportCommand,
  planSourceImportCommand,
} from './sourceImportCommands';

const PNG = new Uint8Array([137, 80, 78, 71]);

function tree(physics = 'Damped oscillations. See [[Index]].') {
  return {
    '/vault': {
      'Index.md':
        '---\ntags: [hub, "topic:Waves"]\n---\nStart with [[Week 4]].\n\n![[spring.png]]',
      'Physics/Week 4.md': physics,
      'Physics/Labs/Pendulum.md': 'Measure g.',
      'spring.png': PNG,
    },
  };
}

async function scan(files = tree()): Promise<SourceScan> {
  const adapter = createMemoryFolderImportAdapter(files);
  return createFolderSource('obsidian', () => adapter).scan('/vault');
}

async function allNotes(): Promise<Note[]> {
  const summaries = await library.queryNotes({ scope: 'all', limit: 100 });
  return (
    await Promise.all(summaries.map((summary) => library.getNote(summary.id)))
  ).filter((note): note is Note => note !== null);
}

function find(doc: { content: DocNode[] }, type: string): DocNode[] {
  const out: DocNode[] = [];
  const walk = (node: DocNode) => {
    if (node.type === type) out.push(node);
    node.content?.forEach(walk);
  };
  doc.content.forEach(walk);
  return out;
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
});

describe('applySourceImportCommand', () => {
  it('writes courses, sections, tags, images and notes whose links carry ids', async () => {
    const planned = await planSourceImportCommand(await scan(), 'obsidian', 'update');
    if (!planned.ok) throw new Error(planned.message);
    const applied = await applySourceImportCommand(planned.value, {
      mapping: { kind: 'folders' },
      keepTags: true,
    });
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.value).toMatchObject({
      created: 3,
      updated: 0,
      images: 1,
      coursesCreated: 1,
    });

    const courses = await library.listCourses();
    expect(courses.map((course) => course.name)).toEqual(['Physics']);
    const sections = await library.listSections(courses[0]!.id);
    expect(sections.map((section) => section.name)).toEqual(['Labs']);

    const notes = await allNotes();
    const byTitle = Object.fromEntries(notes.map((note) => [note.title, note]));
    const index = byTitle.Index!;
    expect(index.courseId).toBeNull();
    expect(index.importKey).toBe('obsidian:Index.md');
    expect(index.importedAt).not.toBeNull();
    expect(byTitle.Pendulum!.sectionId).toBe(sections[0]!.id);

    const [link] = find(index.doc, 'wikiLink');
    expect(link?.attrs?.noteId).toBe(byTitle['Week 4']!.id);
    const [image] = find(index.doc, 'image');
    expect(String(image?.attrs?.assetId)).not.toMatch(/^nb-source/);

    const tags = await library.listTags();
    expect(tags.map((tag) => `${tag.namespace ?? ''}:${tag.name}`).sort()).toEqual([
      ':hub',
      'topic:Waves',
    ]);
    expect(index.tagIds).toHaveLength(2);
  });

  it('importing the same vault twice updates what changed and doubles nothing', async () => {
    const first = await planSourceImportCommand(await scan(), 'obsidian', 'update');
    if (!first.ok) throw new Error(first.message);
    await applySourceImportCommand(first.value, {
      mapping: { kind: 'folders' },
      keepTags: false,
    });

    const second = await planSourceImportCommand(
      await scan(tree('Damped oscillations, revised. See [[Index]].')),
      'obsidian',
      'update',
    );
    if (!second.ok) throw new Error(second.message);
    expect(second.value.counts).toMatchObject({
      create: 0,
      update: 1,
      skip: 2,
      renamed: 0,
    });

    const applied = await applySourceImportCommand(second.value, {
      mapping: { kind: 'folders' },
      keepTags: false,
    });
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.value).toMatchObject({ created: 0, updated: 1, skipped: 2 });

    const notes = await allNotes();
    expect(notes).toHaveLength(3);
    const week = notes.find((note) => note.title === 'Week 4')!;
    expect(week.plainText).toContain('revised');
    const history = await library.listSnapshots(week.id);
    expect(history.map((snapshot) => snapshot.cause)).toEqual(['import']);
    // Still one course: the second import found "Physics" rather than making
    // another.
    expect(await library.listCourses()).toHaveLength(1);
  });

  it('puts everything in one new course named after the source when asked', async () => {
    const planned = await planSourceImportCommand(await scan(), 'obsidian', 'update');
    if (!planned.ok) throw new Error(planned.message);
    const applied = await applySourceImportCommand(planned.value, {
      mapping: { kind: 'course', courseId: null },
      keepTags: false,
    });
    if (!applied.ok) throw new Error(applied.message);
    const courses = await library.listCourses();
    expect(courses.map((course) => course.name)).toEqual(['vault']);
    expect(applied.value.courseId).toBe(courses[0]!.id);
    const notes = await allNotes();
    expect(new Set(notes.map((note) => note.courseId))).toEqual(
      new Set([courses[0]!.id]),
    );
    const sections = await library.listSections(courses[0]!.id);
    expect(sections.map((section) => section.name)).toEqual(['Physics']);
  });
});
