import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { registerPdfExcerptInserter } from '@/editor/commandBridge';
import { createNote, newId, type Attachment, type PdfAnnotation } from '@/lib/schema';
import {
  extractPdfAnnotationCommand,
  savePdfAnnotationsCommand,
} from './pdfAnnotationCommands';

const now = '2026-08-12T08:00:00.000Z';
const annotation: PdfAnnotation = {
  id: 'highlight-1',
  page: 3,
  rects: [{ x1: 10, y1: 20, x2: 90, y2: 32 }],
  text: 'Knowledge is built from sources.',
  comment: 'Use this in the introduction.',
  color: 'yellow',
  createdAt: now,
  updatedAt: now,
};

function attachment(noteId: string): Attachment {
  return {
    id: newId(),
    noteId,
    assetId: 'asset-1',
    name: 'research paper.pdf',
    createdAt: now,
    annotations: [],
  };
}

beforeEach(() => memoryLibraryAdapter.reset());

describe('PDF annotation commands', () => {
  it('persists annotations on their attachment', async () => {
    const note = createNote();
    await memoryLibraryAdapter.upsertNote(note);
    const source = attachment(note.id);
    await memoryLibraryAdapter.upsertAttachment(source);

    const result = await savePdfAnnotationsCommand(source, [annotation]);

    expect(result.ok).toBe(true);
    expect((await memoryLibraryAdapter.listAttachments(note.id))[0]?.annotations).toEqual(
      [annotation],
    );
  });

  it('extracts a highlighted passage with its source metadata', () => {
    const insert = vi.fn(() => true);
    const unregister = registerPdfExcerptInserter(insert);
    const source = attachment('note-1');
    try {
      expect(extractPdfAnnotationCommand(source, annotation).ok).toBe(true);
      expect(insert).toHaveBeenCalledWith({
        attachmentId: source.id,
        annotationId: annotation.id,
        sourceName: source.name,
        page: 3,
        text: annotation.text,
        comment: annotation.comment,
      });
    } finally {
      unregister();
    }
  });
});
