import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createMemoryFolderImportAdapter } from '@/lib/adapters/folderImport/memoryFolderImportAdapter';
import type { DocNode } from '@/lib/schema';
import { createFolderSource } from './folderSource';
import { convertMarkdownNote } from './markdownNote';
import { createNotionSource, notionName, notionProperties } from './notionSource';
import { planSourceImport } from './plan';
import { SourceRefusal } from './SourceImporter';

const PNG = new Uint8Array([137, 80, 78, 71]);

function vault() {
  return createMemoryFolderImportAdapter({
    '/vault': {
      'Index.md': [
        '---',
        'tags: [hub]',
        'aliases: [Home]',
        '---',
        'See [[Week 4|the damping lecture]] and [[Physics/Week 4#Q|questions]].',
        '',
        '![[spring.png]]',
        '',
        '> [!warning] Exam',
        '> Bring a calculator. #exam',
        '',
        '```',
        '![[not-an-embed.png]] #not-a-tag',
        '```',
      ].join('\n'),
      'Physics/Week 4.md': 'Damping. Back to [[Home]]. %%private%% Text ^block-1',
      'Maths/Week 4.md': 'Series. ![[Index]]',
      'Physics/attachments/spring.png': PNG,
      'Physics/paper.pdf': PNG,
      'Drawing.excalidraw.md': '# Excalidraw Data',
      '.obsidian/app.json': '{}',
    },
  });
}

function textOf(node: DocNode | undefined): string {
  if (!node) return '';
  return (node.text ?? '') + (node.content ?? []).map(textOf).join('');
}

function inlines(doc: { content: DocNode[] }, type: string): DocNode[] {
  const out: DocNode[] = [];
  const walk = (node: DocNode) => {
    if (node.type === type) out.push(node);
    node.content?.forEach(walk);
  };
  doc.content.forEach(walk);
  return out;
}

describe('the Obsidian reader', () => {
  it('reads a vault into notes, skipping settings, drawings and other files', async () => {
    const adapter = vault();
    const scan = await createFolderSource('obsidian', () => adapter).scan('/vault');
    expect(scan.notes.map((note) => note.sourceKey).sort()).toEqual([
      'Index.md',
      'Maths/Week 4.md',
      'Physics/Week 4.md',
    ]);
    expect(scan.skipped).toEqual(
      expect.arrayContaining([
        { path: 'Drawing.excalidraw.md', reason: 'excalidraw' },
        { path: 'Physics/paper.pdf', reason: 'notMarkdown' },
      ]),
    );
  });

  it('finds an image by name anywhere in the vault and leaves code alone', async () => {
    const adapter = vault();
    const scan = await createFolderSource('obsidian', () => adapter).scan('/vault');
    const index = scan.notes.find((note) => note.sourceKey === 'Index.md')!;
    expect(index.markdown).toContain('![](asset:nb-source-0)');
    expect(index.markdown).toContain('![[not-an-embed.png]] #not-a-tag');
    expect([...index.attachments.values()].map((attachment) => attachment.key)).toEqual([
      'Physics/attachments/spring.png',
    ]);
    const blob = await index.attachments.get('nb-source-0')!.load();
    expect(blob.type).toBe('image/png');
    expect(index.tags).toEqual([
      { namespace: null, name: 'hub' },
      { namespace: null, name: 'exam' },
    ]);
    expect(index.aliases).toEqual(['Home']);
    expect(index.markdown).toContain('> [!WARN]\n> **Exam**');
  });

  it('strips comments and block ids, and turns a note embed into a link with a warning', async () => {
    const adapter = vault();
    const scan = await createFolderSource('obsidian', () => adapter).scan('/vault');
    const physics = scan.notes.find((note) => note.sourceKey === 'Physics/Week 4.md')!;
    expect(physics.markdown).toBe('Damping. Back to [[Home]].  Text');
    const maths = scan.notes.find((note) => note.sourceKey === 'Maths/Week 4.md')!;
    expect(maths.markdown).toBe('Series. [[Index]]');
    expect(maths.warnings).toEqual([{ code: 'embedAsLink', count: 1 }]);
  });
});

describe('the Markdown folder reader', () => {
  it('turns relative links to notes into wiki links, and finds images only by path', async () => {
    const adapter = createMemoryFolderImportAdapter({
      '/notes': {
        'a.md':
          'Go to [the other one](sub/b%20c.md#part) or [nowhere](gone.md). ![x](img.png)',
        'sub/b c.md': '![fig](../img.png) ![far](elsewhere/img.png)',
        'img.png': PNG,
      },
    });
    const scan = await createFolderSource('markdownFolder', () => adapter).scan('/notes');
    const a = scan.notes.find((note) => note.sourceKey === 'a.md')!;
    expect(a.markdown).toContain('[[sub/b c.md|the other one]]');
    expect(a.markdown).toContain('[[gone|nowhere]]');
    const b = scan.notes.find((note) => note.sourceKey === 'sub/b c.md')!;
    expect(b.attachments.size).toBe(1);
    expect(b.warnings).toEqual([{ code: 'attachmentMissing', count: 1 }]);
  });
});

describe('the Notion reader', () => {
  const ID_A = '0123456789abcdef0123456789abcdef';
  const ID_B = 'fedcba9876543210fedcba9876543210';

  function exportZip(files: Record<string, string | Uint8Array>): Blob {
    const entries = Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        typeof content === 'string' ? strToU8(content) : content,
      ]),
    );
    const bytes = zipSync(entries);
    // jsdom's Blob has no `arrayBuffer`; the webview's does.
    return {
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Blob;
  }

  it('recovers titles and ids from Notion’s names', () => {
    expect(notionName(`Week 4 ${ID_A}.md`)).toEqual({ title: 'Week 4', id: ID_A });
    expect(notionName('Plain.md')).toEqual({ title: 'Plain', id: null });
  });

  it('turns the property block under the title into frontmatter', () => {
    expect(
      notionProperties('# Week 4\n\nTags: waves, exam\nCreated: 2026-09-01\n\nBody'),
    ).toBe('---\ntags: ["waves", "exam"]\ncreated: "2026-09-01"\n---\n# Week 4\n\nBody');
  });

  it('imports pages, rewrites their links, keeps images and refuses database tables', async () => {
    const zip = exportZip({
      [`Export/Physics ${ID_A}.md`]: `# Physics\n\nSee [Week 4](Physics%20${ID_A}/Week%204%20${ID_B}.md).`,
      [`Export/Physics ${ID_A}/Week 4 ${ID_B}.md`]: `# Week 4\n\n![Untitled](Untitled.png)`,
      [`Export/Physics ${ID_A}/Untitled.png`]: PNG,
      [`Export/Readings ${ID_A}.csv`]: 'Name,Tags\n',
    });
    const scan = await createNotionSource(async () => zip).scan('export.zip');
    const physics = scan.notes.find((note) => note.title === 'Physics')!;
    expect(physics.sourceKey).toBe(ID_A);
    expect(physics.markdown).toBe(`See [[Physics ${ID_A}/Week 4 ${ID_B}.md|Week 4]].`);
    const week = scan.notes.find((note) => note.title === 'Week 4')!;
    expect(week.folders).toEqual(['Physics']);
    expect(week.attachments.size).toBe(1);
    expect(scan.skipped).toEqual([{ path: `Readings ${ID_A}.csv`, reason: 'database' }]);

    // The link resolves through the planner to the page's own id.
    const plan = planSourceImport(scan, {
      sourceId: 'notion',
      imported: [],
      titles: [],
      existing: 'update',
    });
    const link = inlines(
      plan.notes.find((note) => note.title === 'Physics')!.doc,
      'wikiLink',
    )[0];
    const weekNote = plan.notes.find((note) => note.title === 'Week 4')!;
    // The label only repeated the title, so it is dropped.
    expect(link?.attrs).toEqual({ title: 'Week 4', noteId: weekNote.noteId });
  });

  it('refuses the HTML flavour of the export by name', async () => {
    const zip = exportZip({ [`Page ${ID_A}.html`]: '<html></html>' });
    await expect(createNotionSource(async () => zip).scan('export.zip')).rejects.toEqual(
      new SourceRefusal('notionHtml'),
    );
  });
});

describe('planning an import', () => {
  async function scanVault() {
    const adapter = vault();
    return createFolderSource('obsidian', () => adapter).scan('/vault');
  }

  it('keeps the shallower title, disambiguates the rest, and links carry ids', async () => {
    let next = 0;
    const plan = planSourceImport(await scanVault(), {
      sourceId: 'obsidian',
      imported: [],
      titles: [{ id: 'old', title: 'Index' }],
      existing: 'update',
      newId: () => `id-${(next += 1)}`,
    });
    const titles = Object.fromEntries(
      plan.notes.map((note) => [note.source.sourceKey, note.title]),
    );
    // `Index` collides with a note already in the library; the two `Week 4`s
    // collide with each other — Maths sorts first at equal depth and keeps it.
    expect(titles).toEqual({
      'Index.md': 'Index (2)',
      'Maths/Week 4.md': 'Week 4',
      'Physics/Week 4.md': 'Week 4 (Physics)',
    });
    expect(plan.counts.renamed).toBe(2);

    const index = plan.notes.find((note) => note.source.sourceKey === 'Index.md')!;
    const physics = plan.notes.find(
      (note) => note.source.sourceKey === 'Physics/Week 4.md',
    )!;
    const maths = plan.notes.find((note) => note.source.sourceKey === 'Maths/Week 4.md')!;
    const links = inlines(index.doc, 'wikiLink').map((node) => node.attrs);
    expect(links).toEqual([
      { title: 'Week 4', noteId: maths.noteId, label: 'the damping lecture' },
      { title: 'Week 4 (Physics)', noteId: physics.noteId, label: 'questions' },
    ]);
    // An alias resolves too.
    expect(inlines(physics.doc, 'wikiLink')[0]?.attrs).toMatchObject({
      noteId: index.noteId,
    });
    expect(textOf(index.doc.content[0])).toContain('See ');
    expect(plan.counts.images).toBe(1);
  });

  it('finds last import’s notes: unchanged is skipped, changed is updated, trashed is new', async () => {
    const scan = await scanVault();
    const first = planSourceImport(scan, {
      sourceId: 'obsidian',
      imported: [],
      titles: [],
      existing: 'update',
    });
    const byKey = Object.fromEntries(
      first.notes.map((note) => [note.source.sourceKey, note]),
    );
    const imported = [
      {
        id: 'n-index',
        importKey: 'obsidian:Index.md',
        title: 'Index',
        plainText: byKey['Index.md']!.plainText,
        updatedAt: '2026-09-01T00:00:00.000Z',
        importedAt: '2026-09-01T00:00:00.000Z',
        trashedAt: null,
      },
      {
        id: 'n-physics',
        importKey: 'obsidian:Physics/Week 4.md',
        title: 'Week 4 (Physics)',
        plainText: 'an older version',
        updatedAt: '2026-09-03T00:00:00.000Z',
        importedAt: '2026-09-01T00:00:00.000Z',
        trashedAt: null,
      },
      {
        id: 'n-maths',
        importKey: 'obsidian:Maths/Week 4.md',
        title: 'Week 4',
        plainText: 'x',
        updatedAt: '2026-09-01T00:00:00.000Z',
        importedAt: '2026-09-01T00:00:00.000Z',
        trashedAt: '2026-09-02T00:00:00.000Z',
      },
    ];
    const plan = planSourceImport(scan, {
      sourceId: 'obsidian',
      imported,
      titles: imported.map(({ id, title }) => ({ id, title })),
      existing: 'update',
    });
    const actions = Object.fromEntries(
      plan.notes.map((note) => [note.source.sourceKey, [note.status, note.action]]),
    );
    expect(actions).toEqual({
      'Index.md': ['unchanged', 'skip'],
      'Physics/Week 4.md': ['changed', 'update'],
      'Maths/Week 4.md': ['new', 'create'],
    });
    expect(plan.counts.editedSinceImport).toBe(1);
    // Kept notes keep their ids, so links still reach them.
    const physics = plan.notes.find(
      (note) => note.source.sourceKey === 'Physics/Week 4.md',
    )!;
    expect(physics.noteId).toBe('n-physics');
    // The trashed copy's title is still taken: `resolveWikiTitle` sees Trash.
    const maths = plan.notes.find((note) => note.source.sourceKey === 'Maths/Week 4.md')!;
    expect(maths.title).toBe('Week 4 (Maths)');

    const skipAll = planSourceImport(scan, {
      sourceId: 'obsidian',
      imported,
      titles: [],
      existing: 'skip',
    });
    expect(skipAll.counts.update).toBe(0);
  });
});

describe('convertMarkdownNote', () => {
  it('keeps an image inside a callout inside the callout, on a line of its own', () => {
    const note = convertMarkdownNote({
      path: 'a.md',
      text: '> [!note]\n> Before ![fig](x.png) after',
      flavour: 'obsidian',
      title: 'a',
      folders: [],
      resolveAttachment: () => ({
        key: 'x.png',
        name: 'x.png',
        load: async () => new Blob(),
      }),
      resolveNoteLink: () => null,
    });
    expect(note.markdown).toBe(
      '> [!INFO]\n> Before\n>\n> ![fig](asset:nb-source-0)\n>\n> after',
    );
  });

  it('reads authors and a source URL into their own facets', () => {
    const note = convertMarkdownNote({
      path: 'paper.md',
      text: '---\nauthor: Ada Lovelace; Alan Turing\nsource: https://www.arxiv.org/abs/1\n---\nBody',
      flavour: 'markdown',
      title: 'paper',
      folders: [],
      resolveAttachment: () => null,
      resolveNoteLink: () => null,
    });
    expect(note.tags).toEqual([
      { namespace: 'author', name: 'Ada Lovelace' },
      { namespace: 'author', name: 'Alan Turing' },
      { namespace: 'source', name: 'arxiv.org' },
    ]);
  });
});
