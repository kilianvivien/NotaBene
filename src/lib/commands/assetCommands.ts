import { assets, dialog, exporter, library } from '@/lib/adapters';
import { canPreviewAttachment } from '@/lib/attachments/previewSupport';
import { documentImportSupported } from '@/lib/import/documentImport';
import { AttachmentSchema, newId, type Asset, type Attachment } from '@/lib/schema';
import { attachmentsChanged } from '@/lib/state/attachmentStore';
import { fail, ok, type CommandResult } from './types';

export async function storeAssetCommand(blob: Blob): Promise<CommandResult<Asset>> {
  try {
    return ok(await assets.put(blob, { mime: blob.type || 'application/octet-stream' }));
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

export async function addAttachmentCommand(
  noteId: string,
  file: File,
): Promise<CommandResult<Attachment>> {
  if (
    !canPreviewAttachment(file.name, file.type) &&
    !documentImportSupported(file.name)
  ) {
    return fail('invalid_input', 'unsupported attachment format');
  }
  const stored = await storeAssetCommand(file);
  if (!stored.ok) return stored;

  const parsed = AttachmentSchema.safeParse({
    id: newId(),
    noteId,
    assetId: stored.value.id,
    name: file.name,
    createdAt: new Date().toISOString(),
    annotations: [],
  });
  if (!parsed.success) {
    return fail('invalid_input', 'invalid attachment', parsed.error.issues);
  }

  try {
    await library.upsertAttachment(parsed.data);
    attachmentsChanged();
    return ok(parsed.data);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

/** Point another note at the same immutable asset bytes. */
export async function copyAttachmentCommand(
  attachment: Attachment,
  noteId: string,
): Promise<CommandResult<Attachment>> {
  const parsed = AttachmentSchema.safeParse({
    ...attachment,
    id: newId(),
    noteId,
    createdAt: new Date().toISOString(),
  });
  if (!parsed.success) {
    return fail('invalid_input', 'invalid attachment', parsed.error.issues);
  }
  try {
    await library.upsertAttachment(parsed.data);
    attachmentsChanged();
    return ok(parsed.data);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

export async function deleteAttachmentCommand(
  attachmentId: string,
): Promise<CommandResult<void>> {
  try {
    await library.deleteAttachment(attachmentId);
    attachmentsChanged();
    return ok(undefined);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

/** Write the original attachment bytes to a user-chosen path. */
export async function saveAttachmentCommand(
  attachment: Attachment,
  destination?: string,
): Promise<CommandResult<string | undefined>> {
  const extension = attachment.name.includes('.')
    ? attachment.name.split('.').pop()?.toLowerCase()
    : undefined;
  const target =
    destination ??
    (await dialog.saveFile({
      defaultPath: attachment.name,
      filters: extension
        ? [{ name: extension.toUpperCase(), extensions: [extension] }]
        : undefined,
    }));
  if (!target) return fail('not_supported', 'save cancelled');

  try {
    const blob = await assets.get(attachment.assetId);
    if (!blob) return fail('not_found', 'attachment data is missing');
    const result = await exporter.write({
      format: 'attachment',
      destination: target,
      suggestedName: attachment.name,
      files: [{ path: attachment.name, contents: blob }],
    });
    return result.ok
      ? ok(result.path)
      : fail('storage_failed', result.error ?? 'attachment export failed');
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}
