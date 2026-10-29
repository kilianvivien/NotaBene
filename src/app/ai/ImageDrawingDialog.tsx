import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { Dialog, FieldNote, GlassButton } from '@/components/glass';
import { assets } from '@/lib/adapters';
import type { ImageDrawingResult } from '@/lib/ai';
import { insertImageDrawingCommand, proposeImageDrawingCommand } from '@/lib/commands';
import { svgDataUri } from '@/lib/mindmap/svg';
import { useUiStore } from '@/lib/state/uiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { AiDialogStatus } from './AiDisclosure';
import { aiErrorMessage } from './aiErrorMessage';
import { useAiAvailability } from './useAiAvailability';

export function ImageDrawingDialog() {
  const { t } = useTranslation();
  const target = useUiStore((state) => state.imageDrawingTarget);
  const noteId = useEditorStore((state) => state.note?.id);
  const running = useAiStore((state) => state.running);
  const availability = useAiAvailability('imageDrawing', target !== null);
  const [result, setResult] = useState<ImageDrawingResult | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const busy = running === 'imageDrawing';

  useEffect(() => {
    generation.current += 1;
    setResult(null);
    setError('');
    setSource(null);
    if (!target) return;
    let active = true;
    let url: string | null = null;
    // Own this preview URL: urlFor may be shared with the inline image view.
    void assets
      .get(String(target.image.attrs?.assetId))
      .then((blob) => {
        if (!active || !blob) return;
        url = URL.createObjectURL(blob);
        setSource(url);
      })
      .catch(() => {
        if (active) setError(t('imageDrawing.missingImage'));
      });
    return () => {
      active = false;
      cancelRun('imageDrawing');
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [target, t]);

  const close = useCallback(() => {
    generation.current += 1;
    cancelRun('imageDrawing');
    useUiStore.getState().setImageDrawingTarget(null);
  }, []);

  useEffect(() => {
    if (target && target.noteId !== noteId) close();
  }, [noteId, target, close]);

  async function generate() {
    if (!target) return;
    const current = ++generation.current;
    setError('');
    const signal = beginRun('imageDrawing');
    const outcome = await proposeImageDrawingCommand(target, { signal });
    endRun('imageDrawing', signal);
    if (generation.current !== current || signal.aborted) return;
    if (outcome.ok) setResult(outcome.value);
    else if (outcome.code !== 'cancelled') setError(aiErrorMessage(outcome, t));
  }

  async function insert(placement: 'after' | 'replace') {
    if (!target || !result) return;
    setSaving(true);
    try {
      const outcome = await insertImageDrawingCommand(target, result, placement);
      if (outcome.ok) close();
      else setError(aiErrorMessage(outcome, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t('imageDrawing.title')}
      description={t('imageDrawing.intro')}
      size="lg"
      headerAction={
        target ? <AiDialogStatus feature="imageDrawing" onLeave={close} /> : undefined
      }
      footer={
        <>
          {busy && (
            <GlassButton size="sm" onClick={() => cancelRun('imageDrawing')}>
              {t('ai.cancel')}
            </GlassButton>
          )}
          <GlassButton
            size="sm"
            disabled={!availability.available || running !== null || saving}
            onClick={() => void generate()}
          >
            {busy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : result ? (
              <RefreshCw size={12} />
            ) : (
              <Sparkles size={12} />
            )}
            {busy
              ? t('ai.running')
              : result
                ? t('ai.regenerate')
                : t('imageDrawing.generate')}
          </GlassButton>
          {result && (
            <>
              <GlassButton
                size="sm"
                disabled={busy || saving}
                onClick={() => void insert('replace')}
              >
                {t('imageDrawing.replace')}
              </GlassButton>
              <GlassButton
                size="sm"
                variant="accent"
                disabled={busy || saving}
                onClick={() => void insert('after')}
              >
                {t('imageDrawing.insert')}
              </GlassButton>
            </>
          )}
        </>
      }
    >
      <div className={result ? 'grid grid-cols-2 gap-4' : ''}>
        {source && (
          <figure className="space-y-2">
            <img
              src={source}
              alt={String(target?.image.attrs?.alt || t('imageDrawing.original'))}
              className="max-h-[400px] w-full object-contain"
            />
            <figcaption className="text-[12px] text-nb-text-3">
              {t('imageDrawing.original')}
            </figcaption>
          </figure>
        )}
        {result && (
          <figure className="space-y-2">
            <img
              src={svgDataUri(result.scene.svg)}
              alt={result.plan.title}
              className="max-h-[400px] w-full object-contain"
            />
            <figcaption className="text-[12px] text-nb-text-3">
              {t('imageDrawing.editable')}
            </figcaption>
          </figure>
        )}
      </div>
      <p className="mt-3 text-[12px] text-nb-text-3">{t('imageDrawing.hint')}</p>
      {result?.plan.warnings.map((warning, index) => (
        <FieldNote key={index}>{warning}</FieldNote>
      ))}
      {!availability.available && (
        <FieldNote>{t(`ai.unavailable_${availability.reason}`)}</FieldNote>
      )}
      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
