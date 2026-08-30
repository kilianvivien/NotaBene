import { markdownToDoc } from '@/editor/markdown';
import { assets, dialog, documentImporter } from '@/lib/adapters';
import { requestReformat, type AiRunOptions, type ReformatResult } from '@/lib/ai';
import {
  DOCUMENT_IMPORT_EXTENSIONS,
  pathFilename,
  type DocumentImportSource,
} from '@/lib/import/documentImport';
import { materialiseAssets } from '@/lib/import/importedAssets';
import type { ImportedDocument, ImportWarning, Note } from '@/lib/schema';
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

/** The scanned pages AnyDoc refused, so OCR can read those and not the rest. */
export interface OcrRequirement {
  /** 1-indexed, as AnyDoc counts them. */
  pages: number[];
  pageCount: number;
}

/** `ocr_required:[1,5,7]/12:pages 1, 5, 7 of 12 need OCR` */
const OCR_REQUIRED = /ocr_required:\[([\d,]*)\]\/(\d+):/;

/**
 * AnyDoc's typed errors, which reach us as `code:message` from
 * `src-tauri/src/document_import.rs`.
 *
 * Each code keeps its own message so the dialog can say what actually went
 * wrong; before 0.9 every one of these except OCR arrived as a single
 * "could not be converted".
 */
function extractionFailure(error: unknown): CommandResult<never> {
  const message = error instanceof Error ? error.message : String(error);

  const ocr = OCR_REQUIRED.exec(message);
  const [, ocrPages, ocrCount] = ocr ?? [];
  if (ocrPages !== undefined && ocrCount !== undefined) {
    const pages = ocrPages
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter((page) => Number.isInteger(page) && page > 0);
    return fail('not_supported', 'ocr_required', {
      pages,
      pageCount: Number(ocrCount),
    } satisfies OcrRequirement);
  }
  if (message.includes('ocr_required:')) {
    // A page list that did not parse still means the document needs OCR; say
    // so rather than reporting a generic failure for a known cause.
    return fail('not_supported', 'ocr_required', message);
  }

  for (const code of [
    'unsupported_format',
    'encrypted',
    'too_large',
    'missing_part',
    'malformed',
  ] as const) {
    if (message.includes(`${code}:`)) {
      return fail(code === 'unsupported_format' ? 'not_supported' : 'invalid_input', code, message);
    }
  }
  return fail('invalid_input', 'conversion_failed', message);
}

/**
 * The bytes behind an import source, and the name to convert them under.
 *
 * Shared with the OCR pass, which needs the same file a second time: reading
 * it twice through two different paths is how the two come to disagree about
 * which document is being imported.
 */
export async function sourceBytesCommand(
  source: DocumentImportSource,
): Promise<CommandResult<{ bytes: Blob; filename: string }>> {
  try {
    if (source.kind === 'path') {
      return ok({ bytes: await dialog.readFile(source.path), filename: source.name });
    }
    const bytes = await assets.get(source.attachment.assetId);
    if (!bytes) return fail('not_found', 'attachment_missing');
    return ok({ bytes, filename: source.attachment.name });
  } catch (error) {
    return extractionFailure(error);
  }
}

export async function extractDocumentCommand(
  source: DocumentImportSource,
): Promise<CommandResult<ImportedDocument>> {
  const read = await sourceBytesCommand(source);
  if (!read.ok) return read;
  try {
    return ok(await documentImporter.extractBytes(read.value.bytes, read.value.filename));
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
  /** Embedded images stored, deduplicated by content hash. */
  imagesKept: number;
  /** The document's own warnings plus anything materialising the images
   *  added, for the surface to translate and show. */
  warnings: ImportWarning[];
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

  // Store the embedded images and point the Markdown at them. This is the
  // only place it happens: storing an asset is a write, so it belongs on the
  // mutation path rather than in the dialog that previews the result.
  const materialised = await materialiseAssets(document);
  const extracted = materialised.markdown;

  // Compared against the *materialised* text, not the raw extraction — the
  // asset rewrite must not make a plain import look like a model wrote it.
  const markdown = reformatted?.trim() ? reformatted : extracted;
  const created = await createNoteCommand(
    {
      ...location,
      title: document.metadata?.title || document.source.filename.replace(/\.[^.]+$/, ''),
      doc: markdownToDoc(markdown),
    },
    markdown === extracted ? undefined : { source: 'ai' },
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
  return ok({
    note: created.value,
    attachmentKept,
    imagesKept: materialised.storedIds.length,
    warnings: [...document.diagnostics.warnings, ...materialised.warnings],
  });
}
