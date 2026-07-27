import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createBackupArchive, parseBackupArchive } from '@/lib/backup';
import { assets } from '@/lib/adapters';
import { notesToDocx } from '@/lib/export/docx';
import { notesToPdf } from '@/lib/export/pdf';
import { docToSemanticHtml } from '@/lib/export/render';
import { retainedSnapshotIds } from '@/lib/history/retention';
import { createNote, emptyLibrary, type NoteDoc } from '@/lib/schema';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { saveEditorNoteCommand } from '@/lib/commands/editorCommands';

const fullVocabulary: NoteDoc = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Heading', marks: [{ type: 'bold' }] }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '<safe>' },
        { type: 'math', attrs: { latex: 'x^2' } },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Item',
                  marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'callout',
      attrs: { kind: 'important' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Remember' }] }],
    },
    {
      type: 'toggle',
      attrs: { summary: 'Details' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden' }] }],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Column' }] },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'const answer = 42;' }],
    },
    { type: 'mathBlock', attrs: { latex: '\\frac{1}{2}' } },
    {
      type: 'drawing',
      attrs: {
        title: 'Diagram',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
      },
    },
  ],
};

describe('Phase D versions, backups, and exports', () => {
  function bytes(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer), {
        once: true,
      });
      reader.addEventListener('error', () => reject(reader.error), { once: true });
      reader.readAsArrayBuffer(blob);
    });
  }

  it('thins old snapshots hourly, daily, and weekly while keeping recent ones', () => {
    const snapshots = [
      ['recent-a', '2026-07-27T11:50:00.000Z'],
      ['recent-b', '2026-07-27T11:40:00.000Z'],
      ['hour-new', '2026-07-25T10:50:00.000Z'],
      ['hour-old', '2026-07-25T10:05:00.000Z'],
      ['day-new', '2026-07-10T18:00:00.000Z'],
      ['day-old', '2026-07-10T08:00:00.000Z'],
      ['week-new', '2026-03-03T18:00:00.000Z'],
      ['week-old', '2026-03-02T08:00:00.000Z'],
    ].map(([id, createdAt]) => ({ id: id!, createdAt: createdAt! }));
    const retained = retainedSnapshotIds(
      snapshots,
      { keepAllDays: 1, keepHourlyDays: 7, keepDailyDays: 90 },
      new Date('2026-07-27T12:00:00.000Z'),
    );
    expect([...retained]).toEqual([
      'recent-a',
      'recent-b',
      'hour-new',
      'day-new',
      'week-new',
    ]);
  });

  it('captures the state opened at the first autosave of a session', async () => {
    memoryLibraryAdapter.reset();
    const original = memoryLibraryAdapter.seedNote({
      id: 'session-note',
      title: 'Before',
    });
    const result = await saveEditorNoteCommand(
      { ...original, title: 'After', updatedAt: new Date().toISOString() },
      'session',
    );
    expect(result.ok).toBe(true);
    const versions = await memoryLibraryAdapter.listSnapshots(original.id);
    expect(versions).toHaveLength(1);
    const saved = await memoryLibraryAdapter.getSnapshot(versions[0]!.id);
    expect(saved?.title).toBe('Before');
  });

  it('creates a versioned backup envelope with no place for secrets', async () => {
    const library = emptyLibrary();
    library.notes.push(createNote({ id: 'note', title: 'Private notes' }));
    const payload = new Blob(['asset bytes'], { type: 'image/png' });
    const asset = await assets.put(payload);
    library.assets.push(asset);
    const archive = await createBackupArchive(library);
    const files = unzipSync(new Uint8Array(await bytes(archive)));
    const manifest = strFromU8(files['manifest.json']!);
    const json = strFromU8(files['library.json']!);

    expect(manifest).toContain('"format": "notabene-backup"');
    expect(json).not.toMatch(/api.?key|secret|settings/i);
    const parsed = await parseBackupArchive(archive);
    expect(parsed.library).toEqual(library);
    expect(await bytes(parsed.assetBlobs.get(asset.id)!)).toEqual(await bytes(payload));
  });

  it('renders the complete block vocabulary as semantic, escaped HTML', () => {
    const html = docToSemanticHtml(fullVocabulary);
    expect(html).toContain('<h2><strong>Heading</strong></h2>');
    expect(html).toContain('&lt;safe&gt;');
    expect(html).toContain('<aside class="callout">');
    expect(html).toContain('<details open>');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre><code');
    expect(html).toContain('<svg');
    expect(html).toContain('katex');
  });

  it('builds a DOCX containing tables, math, drawings, and rich text', async () => {
    const note = createNote({ title: 'Fidelity', doc: fullVocabulary });
    const blob = await notesToDocx([note], new Map());
    const files = unzipSync(new Uint8Array(await bytes(blob)));
    const document = strFromU8(files['word/document.xml']!);
    const styles = strFromU8(files['word/styles.xml']!);
    const relationships = strFromU8(files['word/_rels/document.xml.rels']!);

    expect(document).toContain('<w:tbl>');
    expect(document).toContain('<m:oMath>');
    expect(document).toContain('<w:drawing>');
    expect(document).toContain('Heading');
    expect(document).toContain('IMPORTANT');
    expect(document).toContain('FAEFF3');
    expect(styles).toContain('Arial');
    expect(relationships).toContain('https://example.com');
  });

  it('builds a real PDF with structured note content', async () => {
    const note = createNote({ title: 'Fidelity', doc: fullVocabulary });
    const blob = await notesToPdf([note], new Map(), new Map(), { language: 'en' });
    const data = new Uint8Array(await bytes(blob));
    expect(new TextDecoder().decode(data.slice(0, 5))).toBe('%PDF-');
    expect(data.byteLength).toBeGreaterThan(10_000);
  });
});
