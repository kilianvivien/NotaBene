/**
 * The write half of the diagram feature.
 *
 * Generating is covered where the model is — `ai/diagram.ts` and its prompt.
 * What matters here is what reaches the note: the block that lands has to be
 * indistinguishable from a hand-drawn one, because that is what lets the
 * student open it, pull it apart, and export it through the path drawings
 * already use.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import type { DiagramResult } from '@/lib/ai';
import type { NoteDoc } from '@/lib/schema';
import { createNoteCommand } from './noteCommands';
import { insertDiagramCommand } from './studyCommands';

function docOf(text: string): NoteDoc {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

const result: DiagramResult = {
  answer: { title: 'The study loop', kind: 'flowchart', mermaid: 'flowchart TD\n A-->B' },
  scene: {
    data: {
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: {},
      files: {},
    },
    svg: '<svg><rect /></svg>',
  },
};

beforeEach(() => {
  memoryLibraryAdapter.reset();
});

describe('insertDiagramCommand', () => {
  it('appends a drawing block carrying the scene and its rendered SVG', async () => {
    const created = await createNoteCommand({ doc: docOf('Revision method') });
    if (!created.ok) throw new Error(created.message);

    const inserted = await insertDiagramCommand(created.value.id, result);
    if (!inserted.ok) throw new Error(inserted.message);

    const block = inserted.value.doc.content.at(-1);
    expect(block?.type).toBe('drawing');
    expect(block?.attrs).toMatchObject({
      svg: '<svg><rect /></svg>',
      title: 'The study loop',
    });
    expect(block?.attrs?.data).toMatchObject({
      elements: [{ id: 'a', type: 'rectangle' }],
    });
  });

  /** The Mermaid is scaffolding, not a record. Once a box has been dragged the
   * source no longer describes what is on screen, and a stale source on the
   * node is worse than none. */
  it('does not keep the Mermaid source on the block', async () => {
    const created = await createNoteCommand({ doc: docOf('Revision method') });
    if (!created.ok) throw new Error(created.message);

    const inserted = await insertDiagramCommand(created.value.id, result);
    if (!inserted.ok) throw new Error(inserted.message);

    expect(JSON.stringify(inserted.value.doc.content.at(-1))).not.toContain('flowchart');
  });

  it('keeps what the note already had', async () => {
    const created = await createNoteCommand({ doc: docOf('Revision method') });
    if (!created.ok) throw new Error(created.message);

    const inserted = await insertDiagramCommand(created.value.id, result);
    if (!inserted.ok) throw new Error(inserted.message);

    expect(inserted.value.doc.content).toHaveLength(2);
    expect(inserted.value.doc.content[0]?.type).toBe('paragraph');
  });

  it('refuses a note that is not there rather than inventing one', async () => {
    const inserted = await insertDiagramCommand('missing', result);

    expect(inserted.ok).toBe(false);
    if (!inserted.ok) expect(inserted.code).toBe('not_found');
  });
});
