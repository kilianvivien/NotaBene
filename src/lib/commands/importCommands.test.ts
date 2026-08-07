import { beforeEach, describe, expect, it } from 'vitest';
import { library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import type { ImportedDocument } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { addAttachmentCommand } from './assetCommands';
import { createImportedNoteCommand } from './importCommands';
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
