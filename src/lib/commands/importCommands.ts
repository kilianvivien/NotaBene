import { markdownToDoc } from '@/editor/markdown';
import { assets, dialog, documentImporter } from '@/lib/adapters';
import { requestReformat, type AiRunOptions, type ReformatResult } from '@/lib/ai';
import {
  DOCUMENT_IMPORT_EXTENSIONS,
  pathFilename,
  type DocumentImportSource,
} from '@/lib/import/documentImport';
import type { ImportedDocument, Note } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { providerFor } from './aiCommands';
import { addAttachmentCommand, copyAttachmentCommand } from './assetCommands';
import { createNoteCommand } from './noteCommands';
import { fail, ok, type CommandResult } from './types';

export async function beginDocumentImportCommand(): Promise<CommandResult<void>> {
  try {
    const [path] = await dialog.openFile({
      multiple: false,
      filters: [
        {
          name: 'Documents',
          extensions: [...DOCUMENT_IMPORT_EXTENSIONS],
        },
      ],
    });
    if (!path) return ok(undefined);
    useUiStore.getState().setDocumentImportSource({
      kind: 'path',
      path,
      name: pathFilename(path),
    });
    return ok(undefined);
  } catch (error) {
    return fail('not_supported', String(error));
  }
}

export function beginAttachmentImportCommand(source: DocumentImportSource): void {
  useUiStore.getState().setDocumentImportSource(source);
}

function extractionFailure(error: unknown): CommandResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ocr_required:')) {
    return fail('not_supported', 'ocr_required', message);
  }
  if (message.includes('unsupported_format:')) {
    return fail('not_supported', 'unsupported_format', message);
  }
  return fail('invalid_input', 'conversion_failed', message);
}

export async function extractDocumentCommand(
  source: DocumentImportSource,
): Promise<CommandResult<ImportedDocument>> {
  try {
    if (source.kind === 'path') {
      const bytes = await dialog.readFile(source.path);
      return ok(await documentImporter.extractBytes(bytes, source.name));
    }
    const bytes = await assets.get(source.attachment.assetId);
    if (!bytes) return fail('not_found', 'attachment_missing');
    return ok(await documentImporter.extractBytes(bytes, source.attachment.name));
  } catch (error) {
    return extractionFailure(error);
  }
}

/**
 * Optional second stage: ask the configured model to lay the document out.
 *
 * Off by default, and a separate step on purpose — extraction is local and
 * always happens, this leaves the Mac. It writes nothing and returns nothing
 * but Markdown; the note is still created by the command below, from whichever
 * version the student is looking at when they press the button.
 */
export async function reformatDocumentCommand(
  document: ImportedDocument,
  options: AiRunOptions = {},
): Promise<CommandResult<ReformatResult>> {
  const lookup = await providerFor('importFormat');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    return ok(
      await requestReformat(
        { provider: lookup.provider, markdown: document.markdown },
        options,
      ),
    );
  } catch (error) {
    return fail('invalid_input', error instanceof Error ? error.message : String(error));
  }
}

export interface ImportedNoteResult {
  note: Note;
  attachmentKept: boolean;
}

/** Final pipeline stage: normal note creation plus optional source provenance.
 *
 * `reformatted` is the Markdown a model laid out, when the student asked for
 * that and it succeeded. It arrives as an argument rather than folded into
 * `document` so the note records who shaped it: a reformatted import is written
 * with `source: 'ai'`, like every other note a model had a hand in. */
export async function createImportedNoteCommand(
  document: ImportedDocument,
  source: DocumentImportSource,
  keepOriginal: boolean,
  reformatted?: string | null,
): Promise<CommandResult<ImportedNoteResult>> {
  const view = useUiStore.getState().view;
  const location =
    view.kind === 'course'
      ? { courseId: view.courseId, sectionId: view.sectionId ?? null }
      : {};
  const markdown = reformatted?.trim() ? reformatted : document.markdown;
  const created = await createNoteCommand(
    {
      ...location,
      title: document.metadata?.title || document.source.filename.replace(/\.[^.]+$/, ''),
      doc: markdownToDoc(markdown),
    },
    markdown === document.markdown ? undefined : { source: 'ai' },
  );
  if (!created.ok) return created;

  let attachmentKept = !keepOriginal;
  if (keepOriginal) {
    if (source.kind === 'attachment') {
      attachmentKept = (await copyAttachmentCommand(source.attachment, created.value.id))
        .ok;
    } else {
      try {
        const bytes = await dialog.readFile(source.path);
        const original = new File([bytes], source.name, {
          type: bytes.type || 'application/octet-stream',
        });
        attachmentKept = (await addAttachmentCommand(created.value.id, original)).ok;
      } catch {
        attachmentKept = false;
      }
    }
  }

  useUiStore.getState().selectNote(created.value.id);
  await useEditorStore.getState().openNote(created.value.id);
  return ok({ note: created.value, attachmentKept });
}
