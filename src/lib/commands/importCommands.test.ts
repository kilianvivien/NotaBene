import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentImporter, library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import type { ImportedDocument } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { addAttachmentCommand } from './assetCommands';
import { createImportedNoteCommand, extractDocumentCommand } from './importCommands';
import { createNoteCommand } from './noteCommands';

const imported: ImportedDocument = {
  source: { filename: 'lecture.csv', format: 'csv' },
  markdown: '# Lecture data\n\n| Year | Event |\n| --- | --- |\n| 1789 | Revolution |',
  assets: [],
  metadata: { title: 'Lecture data' },
  diagnostics: { parser: 'anydoc', warnings: [], requiresOcr: false },
};

beforeEach(async () => {
  memoryLibraryAdapter.reset();
  useUiStore.getState().setView({ kind: 'all' });
  useUiStore.getState().setDocumentImportSource(null);
  await useEditorStore.getState().closeNote();
});

describe('createImportedNoteCommand', () => {
  it('creates a normal searchable note and preserves an attachment source', async () => {
    const sourceNote = await createNoteCommand({ title: 'Source' });
    expect(sourceNote.ok).toBe(true);
    if (!sourceNote.ok) return;

    const attached = await addAttachmentCommand(
      sourceNote.value.id,
      new File(['year,event\n1789,revolution'], 'lecture.csv', { type: 'text/csv' }),
    );
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const result = await createImportedNoteCommand(
      imported,
      { kind: 'attachment', attachment: attached.value },
      true,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.note.title).toBe('Lecture data');
    expect(result.value.note.plainText).toContain('1789');
    expect(result.value.attachmentKept).toBe(true);
    expect(await library.listAttachments(result.value.note.id)).toMatchObject([
      { name: 'lecture.csv', assetId: attached.value.assetId },
    ]);
    expect(useEditorStore.getState().note?.id).toBe(result.value.note.id);
  });
});

describe('extractDocumentCommand error mapping', () => {
  /**
   * AnyDoc's typed errors reach the command layer as `code:message` strings
   * from Rust. Before 0.9 everything but OCR collapsed into one unhelpful
   * "could not be converted", so these assert the codes stay distinguishable.
   */
  async function failWith(message: string) {
    const note = await createNoteCommand({ title: 'Source' });
    if (!note.ok) throw new Error('fixture note failed');
    const attached = await addAttachmentCommand(
      note.value.id,
      new File(['x'], 'paper.pdf', { type: 'application/pdf' }),
    );
    if (!attached.ok) throw new Error('fixture attachment failed');

    vi.spyOn(documentImporter, 'extractBytes').mockRejectedValue(new Error(message));
    return extractDocumentCommand({ kind: 'attachment', attachment: attached.value });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the scanned page list so only those pages need reading', async () => {
    const result = await failWith('ocr_required:[1,5,7]/12:pages 1, 5, 7 of 12 need OCR');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('ocr_required');
    expect(result.details).toEqual({ pages: [1, 5, 7], pageCount: 12 });
  });

  it('still reports OCR when the page list is unparseable', async () => {
    const result = await failWith('ocr_required:the whole thing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('ocr_required');
  });

  it('separates the failures that used to share one message', async () => {
    for (const [wire, code] of [
      ['encrypted:document is encrypted', 'encrypted'],
      ['too_large:resource limit exceeded (nesting): 300', 'too_large'],
      ['missing_part:missing required part: word/document.xml', 'missing_part'],
      ['malformed:malformed document: torn', 'malformed'],
      ['unsupported_format:unsupported input: nope', 'unsupported_format'],
    ] as const) {
      const result = await failWith(wire);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toBe(code);
    }
  });

  it('falls back to conversion_failed for an unrecognised error', async () => {
    const result = await failWith('something nobody mapped');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('conversion_failed');
  });
});
