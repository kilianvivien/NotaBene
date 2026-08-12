import { library } from '@/lib/adapters';
import { insertPdfExcerpt } from '@/editor/commandBridge';
import {
  AttachmentSchema,
  PdfAnnotationSchema,
  type Attachment,
  type PdfAnnotation,
} from '@/lib/schema';
import { attachmentsChanged } from '@/lib/state/attachmentStore';
import { fail, ok, type CommandResult } from './types';

export async function savePdfAnnotationsCommand(
  attachment: Attachment,
  annotations: PdfAnnotation[],
): Promise<CommandResult<Attachment>> {
  const parsed = AttachmentSchema.safeParse({ ...attachment, annotations });
  if (!parsed.success) {
    return fail('invalid_input', 'invalid PDF annotations', parsed.error.issues);
  }
  try {
    await library.upsertAttachment(parsed.data);
    attachmentsChanged();
    return ok(parsed.data);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

export function extractPdfAnnotationCommand(
  attachment: Attachment,
  annotation: PdfAnnotation,
): CommandResult<void> {
  const parsed = PdfAnnotationSchema.safeParse(annotation);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid PDF annotation', parsed.error.issues);
  }
  const inserted = insertPdfExcerpt({
    attachmentId: attachment.id,
    annotationId: parsed.data.id,
    sourceName: attachment.name,
    page: parsed.data.page,
    text: parsed.data.text,
    comment: parsed.data.comment,
  });
  return inserted
    ? ok(undefined)
    : fail('not_supported', 'open a note before extracting a PDF highlight');
}
