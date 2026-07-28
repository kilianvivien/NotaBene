import { assets, library } from '@/lib/adapters';
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
  const stored = await storeAssetCommand(file);
  if (!stored.ok) return stored;

  const parsed = AttachmentSchema.safeParse({
    id: newId(),
    noteId,
    assetId: stored.value.id,
    name: file.name,
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
