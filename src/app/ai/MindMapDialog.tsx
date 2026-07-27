/**
 * Mind map.
 *
 * Generate, look at it, then decide. The preview is the whole dialog because
 * the only question worth asking about a mind map is whether it is the right
 * shape, and that is not a question a list of node labels can answer.
 *
 * Nothing is written until Insert. A map the model got wrong costs one more
 * press of Generate, not an edit to unpick.
 */
import { Loader2, Maximize2, Network, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MindMapViewer } from '@/app/mindmap/MindMapViewer';
import { Dialog, FieldNote, GlassButton } from '@/components/glass';
import type { MindMapResult } from '@/lib/ai';
import { insertMindMapCommand, proposeMindMapCommand } from '@/lib/commands';
import { svgDataUri } from '@/lib/mindmap/svg';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { AiStatusPill } from './AiStatusPill';
import { useAiAvailability } from './useAiAvailability';

export function MindMapDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.aiMindMapOpen);
  const setOpen = useUiStore((state) => state.setAiMindMapOpen);
  const noteId = useEditorStore((state) => state.note?.id ?? null);
  const running = useAiStore((state) => state.running) === 'mindMap';
  const availability = useAiAvailability('mindMap');

  const [result, setResult] = useState<MindMapResult | null>(null);
  const [viewing, setViewing] = useState(false);
  const [error, setError] = useState('');

  // A map of the note you were on is not a map of the note you are on now.
  useEffect(() => {
    setResult(null);
    setViewing(false);
    setError('');
  }, [noteId]);

  async function generate() {
    if (!noteId) return;
    setError('');
    const signal = beginRun('mindMap');
    const outcome = await proposeMindMapCommand(noteId, { signal });
    endRun('mindMap');

    if (!outcome.ok) {
      setError(
        outcome.code === 'not_supported' ? t('ai.notConfiguredHint') : outcome.message,
      );
      return;
    }
    setResult(outcome.value);
  }

  async function insert() {
    if (!noteId || !result) return;
    const outcome = await insertMindMapCommand(noteId, result);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setOpen(false);
    setResult(null);
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        cancelRun('mindMap');
        setOpen(false);
      }}
      title={t('ai.mindMap')}
      description={t('ai.mindMapIntro')}
      size="lg"
      headerAction={<AiStatusPill feature="mindMap" className="max-w-[200px]" />}
      footer={
        <>
          {running ? (
            <GlassButton size="sm" onClick={() => cancelRun('mindMap')}>
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
          {/* The preview is deliberately small and the real view is one click
              away: a map big enough to read does not fit in a dialog, and a
              dialog stretched until it does is a worse full-screen viewer. */}
          <button
            type="button"
            className="nb-mind-map-preview"
            onClick={() => setViewing(true)}
            aria-label={t('ai.mindMapZoom')}
          >
            <img
              src={svgDataUri(result.svg)}
              alt={result.map.title}
              draggable={false}
            />
            <span className="nb-mind-map-open">
              <Maximize2 size={13} aria-hidden />
              {t('ai.mindMapZoom')}
            </span>
          </button>
          <figcaption className="text-[12px] text-nb-text-3">
            {result.map.title} ·{' '}
            {t('ai.mindMapNodes', { count: result.map.nodes.length })}
          </figcaption>
          {viewing && (
            <MindMapViewer
              svg={result.svg}
              title={result.map.title}
              onClose={() => setViewing(false)}
            />
          )}
        </figure>
      ) : (
        <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-nb-sm border border-dashed border-[var(--nb-divider)] text-nb-text-3">
          <Network size={26} aria-hidden />
          <p className="max-w-[42ch] px-6 text-center text-[12px] leading-snug">
            {t('ai.mindMapEmpty')}
          </p>
        </div>
      )}

      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
