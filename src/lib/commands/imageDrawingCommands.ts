import i18n from '@/lib/i18n';
import { assets, library } from '@/lib/adapters';
import {
  requestImageDrawing,
  type AiRunOptions,
  type ImageDrawingResult,
} from '@/lib/ai';
import { drawingNode } from '@/lib/diagram/mermaid';
import { imageDrawingHostFor } from '@/editor/commandBridge';
import { newId } from '@/lib/schema/defaults';
import { useImageDrawingStore } from '@/lib/state/imageDrawingStore';
import { imageForVision } from '@/lib/images/vision';
import { locateImageTarget, type ImageDrawingTarget } from '@/lib/notes/imageTargets';
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
    if (!note) return fail('not_found', `no note ${target.noteId}`);
    const lookup = await providerFor('imageDrawing');
    if (!lookup.ok) return fail('not_supported', lookup.reason);
    // The note references immutable bytes in its internal asset store. Neither
    // the source file nor the image's current document position is needed.
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
  if (!note) return fail('not_found', `no note ${target.noteId}`);
  const source = locateImageTarget(note.doc, target);
  if (!source) {
    return fail('conflict', i18n.t('imageDrawing.sourceChanged'));
  }
  const doc = structuredClone(note.doc);
  let nodes: DocNode[] = doc.content;
  for (const index of source.path.slice(0, -1)) nodes = nodes[index]!.content!;
  const index = source.path.at(-1)!;
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
  // Reload only an editor that is showing this note — a background job that
  // finishes after the student moved on must not pull them back to it.
  if (
    updated.ok &&
    context.source !== 'agent' &&
    useEditorStore.getState().note?.id === note.id
  )
    await useEditorStore.getState().openNote(note.id);
  return updated;
}

/**
 * Inline reconstruction: the student asks from the image, the image shows the
 * work in progress, and the drawing lands directly below it — no dialog, no
 * preview to confirm, nothing that stops them typing. The preview step the
 * dialog had is replaced by the drawing itself, which is one undo away.
 *
 * Each job has its own controller, so several images can be redrawn at once
 * and none of them occupies the one-at-a-time `aiStore.running` slot the AI
 * dialogs share.
 */
const controllers = new Map<string, AbortController>();

export function startImageDrawingCommand(target: ImageDrawingTarget): string {
  const id = newId();
  useImageDrawingStore.getState().put({ id, target, status: 'running', warnings: [] });
  void runImageDrawingJob(id);
  return id;
}

export function retryImageDrawingCommand(jobId: string): void {
  if (useImageDrawingStore.getState().jobs[jobId]?.status !== 'failed') return;
  void runImageDrawingJob(jobId);
}

/** Stop a job, if it is still running, and forget it. */
export function forgetImageDrawingCommand(jobId: string): void {
  controllers.get(jobId)?.abort(new DOMException('cancelled', 'AbortError'));
  controllers.delete(jobId);
  useImageDrawingStore.getState().remove(jobId);
}

/** The editor showing `noteId` went away. A finished job's bar belonged to
 * that view; running and failed jobs are picked up again when it comes back. */
export function releaseImageDrawingJobsCommand(noteId: string): void {
  const { jobs, remove } = useImageDrawingStore.getState();
  for (const job of Object.values(jobs)) {
    if (job.target.noteId === noteId && job.status === 'done') remove(job.id);
  }
}

async function runImageDrawingJob(jobId: string): Promise<void> {
  const store = useImageDrawingStore.getState();
  const job = store.jobs[jobId];
  if (!job) return;
  controllers.get(jobId)?.abort(new DOMException('cancelled', 'AbortError'));
  const controller = new AbortController();
  controllers.set(jobId, controller);
  const current = () =>
    controllers.get(jobId) === controller && !controller.signal.aborted;
  store.patch(jobId, { status: 'running', failure: undefined, warnings: [] });
  try {
    const proposed = await proposeImageDrawingCommand(job.target, {
      signal: controller.signal,
    });
    if (!current()) return;
    if (!proposed.ok) {
      if (proposed.code === 'cancelled') store.remove(jobId);
      else store.patch(jobId, { status: 'failed', failure: proposed });
      return;
    }
    const { plan, scene } = proposed.value;
    const host = imageDrawingHostFor(job.target.noteId);
    if (host) {
      // The open note is the student's live document: place it there, or not
      // at all — an image they deleted meanwhile means they changed their mind.
      if (host.place(jobId, drawingNode(scene, plan.title)))
        store.patch(jobId, { status: 'done', warnings: plan.warnings });
      else store.remove(jobId);
      return;
    }
    const written = await insertImageDrawingCommand(job.target, proposed.value, 'after');
    if (!current()) return;
    if (written.ok) store.remove(jobId);
    else store.patch(jobId, { status: 'failed', failure: written });
  } finally {
    if (controllers.get(jobId) === controller) controllers.delete(jobId);
  }
}
