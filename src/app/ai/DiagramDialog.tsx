/**
 * Diagram.
 *
 * Generate, look at it, then decide — the mind map dialog's shape, for the same
 * reason: the only useful question about a diagram is whether it is the right
 * picture, and no list of node labels answers that.
 *
 * The preview is the rendered scene rather than the Mermaid, because the
 * Mermaid is scaffolding. A student who wants to change the diagram edits it as
 * a drawing after inserting it, which is what going through Excalidraw buys.
 * Nothing is written until Insert.
 */
import { Loader2, RefreshCw, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, FieldNote, GlassButton } from '@/components/glass';
import type { DiagramResult } from '@/lib/ai';
import { insertDiagramCommand, proposeDiagramCommand } from '@/lib/commands';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { AiDialogStatus } from './AiDisclosure';
import { useAiAvailability } from './useAiAvailability';

export function DiagramDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.aiDiagramOpen);
  const setOpen = useUiStore((state) => state.setAiDiagramOpen);
  const noteId = useEditorStore((state) => state.note?.id ?? null);
  const running = useAiStore((state) => state.running) === 'diagram';
  const availability = useAiAvailability('diagram');

  const [result, setResult] = useState<DiagramResult | null>(null);
  const [error, setError] = useState('');

  // A diagram of the note you were on is not a diagram of the note you are on.
  useEffect(() => {
    setResult(null);
    setError('');
  }, [noteId]);

  async function generate() {
    if (!noteId) return;
    setError('');
    const signal = beginRun('diagram');
    const outcome = await proposeDiagramCommand(noteId, { signal });
    endRun('diagram', signal);

    if (!outcome.ok) {
      if (outcome.code !== 'cancelled') {
        setError(
          outcome.code === 'not_supported' ? t('ai.notConfiguredHint') : outcome.message,
        );
      }
      return;
    }
    setResult(outcome.value);
  }

  async function insert() {
    if (!noteId || !result) return;
    const outcome = await insertDiagramCommand(noteId, result);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setOpen(false);
    setResult(null);
  }

  function close() {
    cancelRun('diagram');
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('ai.diagram')}
      description={t('ai.diagramIntro')}
      size="lg"
      headerAction={<AiDialogStatus feature="diagram" onLeave={close} />}
      footer={
        <>
          {running ? (
            <GlassButton size="sm" onClick={() => cancelRun('diagram')}>
              {t('ai.cancel')}
            </GlassButton>
          ) : (
            <GlassButton size="sm" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </GlassButton>
          )}
          <GlassButton
            size="sm"
            variant={result ? 'ghost' : 'accent'}
            disabled={!noteId || !availability.available || running}
            onClick={() => void generate()}
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              result && <RefreshCw size={12} />
            )}
            {running ? t('ai.running') : result ? t('ai.regenerate') : t('ai.generate')}
          </GlassButton>
          {result && (
            <GlassButton size="sm" variant="accent" onClick={() => void insert()}>
              {t('ai.insertIntoNote')}
            </GlassButton>
          )}
        </>
      }
    >
      {result ? (
        <figure className="flex flex-col gap-2">
          <div className="nb-diagram-preview">
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.scene.svg)}`}
              alt={result.answer.title}
              draggable={false}
            />
          </div>
          <figcaption className="text-[12px] text-nb-text-3">
            {result.answer.title} · {t(`ai.diagramKind_${result.answer.kind}`)}
          </figcaption>
        </figure>
      ) : (
        <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-nb-sm border border-dashed border-[var(--nb-divider)] text-nb-text-3">
          <Workflow size={26} aria-hidden />
          <p className="max-w-[42ch] px-6 text-center text-[12px] leading-snug">
            {t('ai.diagramEmpty')}
          </p>
        </div>
      )}

      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
