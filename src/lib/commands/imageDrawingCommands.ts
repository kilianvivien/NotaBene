import i18n from '@/lib/i18n';
import { assets, library } from '@/lib/adapters';
import {
  requestImageDrawing,
  type AiRunOptions,
  type ImageDrawingResult,
} from '@/lib/ai';
import { drawingNode } from '@/lib/diagram/mermaid';
import { imageForVision } from '@/lib/images/vision';
import { imageAtTarget, type ImageDrawingTarget } from '@/lib/notes/imageTargets';
import type { DocNode, Note } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { aiFailure, providerFor } from './aiCommands';
import { updateNoteCommand } from './noteCommands';
import type { StudyWrite } from './studyCommands';
import { fail, ok, type CommandResult } from './types';

export async function proposeImageDrawingCommand(
  target: ImageDrawingTarget,
  options: AiRunOptions = {},
): Promise<CommandResult<ImageDrawingResult>> {
  try {
    await useEditorStore.getState().flush();
    if (options.signal?.aborted) return fail('cancelled', 'cancelled');
    const note = await library.getNote(target.noteId);
    if (!note || !imageAtTarget(note.doc, target)) {
      return fail('conflict', i18n.t('imageDrawing.sourceChanged'));
    }
    const lookup = await providerFor('imageDrawing');
    if (!lookup.ok) return fail('not_supported', lookup.reason);
    const blob = await assets.get(String(target.image.attrs?.assetId));
    if (!blob) return fail('not_found', i18n.t('imageDrawing.missingImage'));
    let image;
    try {
      image = await imageForVision(blob);
    } catch {
      return fail('invalid_input', i18n.t('imageDrawing.unreadableImage'));
    }
    if (options.signal?.aborted) return fail('cancelled', 'cancelled');
    return ok(await requestImageDrawing({ provider: lookup.provider, image }, options));
  } catch (error) {
    return aiFailure(error, options.signal);
  }
}

/** Locate the original again after preview; never replace whichever block now
 * happens to occupy its old position. Other note edits are retained. */
export async function insertImageDrawingCommand(
  target: ImageDrawingTarget,
  result: ImageDrawingResult,
  placement: 'after' | 'replace' = 'after',
  write: StudyWrite = {},
): Promise<CommandResult<Note>> {
  await useEditorStore.getState().flush();
  if (write.context?.signal?.aborted) return fail('cancelled', 'cancelled');
  const note = await library.getNote(target.noteId);
  if (!note || !imageAtTarget(note.doc, target)) {
    return fail('conflict', i18n.t('imageDrawing.sourceChanged'));
  }
  const doc = structuredClone(note.doc);
  let nodes: DocNode[] = doc.content;
  for (const index of target.path.slice(0, -1)) nodes = nodes[index]!.content!;
  const index = target.path.at(-1)!;
  nodes.splice(
    placement === 'replace' ? index : index + 1,
    placement === 'replace' ? 1 : 0,
    drawingNode(result.scene, result.plan.title),
  );
  const context = write.context ?? { source: 'ai' as const };
  const updated = await updateNoteCommand(
    {
      noteId: note.id,
      baseUpdatedAt: write.baseUpdatedAt ?? note.updatedAt,
      doc,
    },
    context,
  );
  if (updated.ok && context.source !== 'agent')
    await useEditorStore.getState().openNote(note.id);
  return updated;
}
