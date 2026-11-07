/**
 * The image → drawing job, told on the image itself: what it is doing while
 * the model works, and — once the drawing has landed below — whether to keep
 * the original. Every action here is an ordinary editor transaction, so ⌘Z
 * brings back whatever it removed.
 */
import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { AlertCircle, Check, RotateCw, Sparkles, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AiDisclosureButton } from '@/app/ai/AiDisclosure';
import { AiStatusPill } from '@/app/ai/AiStatusPill';
import { aiErrorMessage } from '@/app/ai/aiErrorMessage';
import { retryImageDrawingCommand } from '@/lib/commands/imageDrawingCommands';
import type { ImageDrawingJob } from '@/lib/state/imageDrawingStore';
import { trackedImageDrawing, untrackImageDrawing } from './ImageDrawingJobs';

export function ImageDrawingBar({
  job,
  editor,
  getPos,
  imageSize,
}: {
  job: ImageDrawingJob;
  editor: Editor;
  getPos: () => number | undefined;
  imageSize: number;
}) {
  const { t } = useTranslation();

  /** Untracking is the one way out: the plugin reports the job lost, and the
   * command layer stops the request and forgets it. */
  const dismiss = () => {
    if (!editor.isDestroyed) untrackImageDrawing(editor.view, job.id);
  };

  const removeRange = (from: number, size: number) => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(closeHistory(editor.state.tr.delete(from, from + size)));
    editor.view.dispatch(closeHistory(editor.state.tr));
  };

  const removeImage = () => {
    const pos = getPos();
    if (typeof pos === 'number') removeRange(pos, imageSize);
  };

  const discardDrawing = () => {
    const at = trackedImageDrawing(editor.state, job.id)?.drawing;
    const drawing = typeof at === 'number' ? editor.state.doc.nodeAt(at) : null;
    if (drawing && typeof at === 'number') removeRange(at, drawing.nodeSize);
  };

  return (
    <div
      className="nb-redraw-bar"
      data-status={job.status}
      contentEditable={false}
      role="status"
      aria-live="polite"
    >
      {job.status === 'running' && (
        <>
          <Sparkles size={13} className="nb-redraw-spark" aria-hidden />
          <span className="nb-redraw-text">{t('imageDrawing.running')}</span>
          <AiStatusPill feature="imageDrawing" modelOnly />
          <AiDisclosureButton />
          <button type="button" className="nb-redraw-action" onClick={dismiss}>
            {t('ai.cancel')}
          </button>
        </>
      )}

      {job.status === 'done' && (
        <>
          <Check size={13} className="nb-redraw-ok" aria-hidden />
          <span className="nb-redraw-text" title={job.warnings.join('\n') || undefined}>
            {t('imageDrawing.done')}
            {job.warnings.length > 0 && (
              <span className="nb-redraw-warning">
                {' '}
                {t('imageDrawing.checkWarnings', { count: job.warnings.length })}
              </span>
            )}
          </span>
          <button
            type="button"
            className="nb-redraw-action"
            data-primary
            onClick={removeImage}
          >
            {t('imageDrawing.removeImage')}
          </button>
          <button type="button" className="nb-redraw-action" onClick={dismiss}>
            {t('imageDrawing.keepBoth')}
          </button>
          <button
            type="button"
            className="nb-redraw-icon"
            aria-label={t('imageDrawing.discard')}
            title={t('imageDrawing.discard')}
            onClick={discardDrawing}
          >
            <Trash2 size={13} />
          </button>
        </>
      )}

      {job.status === 'failed' && (
        <>
          <AlertCircle size={13} className="nb-redraw-error" aria-hidden />
          <span className="nb-redraw-text">
            {job.failure ? aiErrorMessage(job.failure, t) : t('imageDrawing.failed')}
          </span>
          <button
            type="button"
            className="nb-redraw-action"
            onClick={() => retryImageDrawingCommand(job.id)}
          >
            <RotateCw size={12} aria-hidden />
            {t('imageDrawing.retry')}
          </button>
          <button
            type="button"
            className="nb-redraw-icon"
            aria-label={t('imageDrawing.dismiss')}
            title={t('imageDrawing.dismiss')}
            onClick={dismiss}
          >
            <X size={13} />
          </button>
        </>
      )}
    </div>
  );
}
