/**
 * Check this paragraph — on request, never while typing.
 *
 * Built like the definition dialog: it runs the moment it opens, because the
 * student already said which paragraph by putting the caret in it. Every
 * correction arrives ticked and can be unticked; nothing reaches the note
 * until Apply, and then it arrives through the editor as one edit, so it
 * autosaves, versions and undoes like anything typed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Loader2, SpellCheck2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, FieldNote, GlassButton } from '@/components/glass';
import { AiDialogStatus } from '@/app/ai/AiDisclosure';
import { useAiAvailability } from '@/app/ai/useAiAvailability';
import type { ProofreadCorrection } from '@/lib/ai';
import { proofreadCommand } from '@/lib/commands';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import type { ProofreadRequest } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';

export type AcceptedCorrection = Pick<
  ProofreadCorrection,
  'index' | 'original' | 'replacement'
>;

export function ProofreadDialog({
  request,
  courseId,
  onClose,
  onApply,
}: {
  request: ProofreadRequest | null;
  /** Whose vocabulary to protect from "correction". */
  courseId: string | null;
  onClose(): void;
  /** Returns false when the paragraph changed and nothing was applied. */
  onApply(corrections: AcceptedCorrection[]): boolean;
}) {
  const { t } = useTranslation();
  const running = useAiStore((state) => state.running) === 'proofread';
  const availability = useAiAvailability('proofread', request !== null);

  const [corrections, setCorrections] = useState<ProofreadCorrection[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');

  // Fire once per request object, for the reason `DefineDialog` gives.
  const checked = useRef<object | null>(null);

  useEffect(() => {
    if (!request) {
      checked.current = null;
      return;
    }
    if (checked.current === request) return;
    checked.current = request;
    setCorrections(null);
    setChosen(new Set());
    setError('');
    void check(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  async function check(target: ProofreadRequest): Promise<void> {
    setError('');
    const signal = beginRun('proofread');
    const outcome = await proofreadCommand(
      { paragraph: target.paragraph, courseId },
      { signal },
    );
    endRun('proofread', signal);
    if (!outcome.ok) {
      if (outcome.code === 'cancelled') return;
      setCorrections(null);
      setError(
        outcome.code === 'not_supported'
          ? t('ai.notConfiguredHint')
          : outcome.code === 'invalid_input'
            ? t('proofread.tooLong')
            : outcome.message,
      );
      return;
    }
    setCorrections(outcome.value);
    setChosen(new Set(outcome.value.map((_, index) => index)));
  }

  const close = useCallback((): void => {
    cancelRun('proofread');
    onClose();
  }, [onClose]);

  function toggle(index: number): void {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function apply(): void {
    if (!corrections) return;
    const accepted = corrections.filter((_, index) => chosen.has(index));
    if (!onApply(accepted)) {
      setError(t('proofread.changed'));
      return;
    }
    close();
  }

  const open = request !== null;
  const canCheck = availability.available && !running && request !== null;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('proofread.title')}
      description={t('proofread.hint')}
      size="md"
      headerAction={<AiDialogStatus feature="proofread" onLeave={close} />}
      footer={
        <>
          {running ? (
            <GlassButton size="sm" onClick={() => cancelRun('proofread')}>
              {t('ai.cancel')}
            </GlassButton>
          ) : (
            <GlassButton size="sm" variant="ghost" onClick={close}>
              {t('common.cancel')}
            </GlassButton>
          )}
          <GlassButton
            size="sm"
            variant={corrections?.length ? 'ghost' : 'accent'}
            disabled={!canCheck}
            onClick={() => request && void check(request)}
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <SpellCheck2 size={12} aria-hidden />
            )}
            {running ? t('ai.running') : t('proofread.checkAgain')}
          </GlassButton>
          {corrections && corrections.length > 0 && (
            <GlassButton
              size="sm"
              variant="accent"
              disabled={chosen.size === 0 || running}
              onClick={apply}
            >
              <Check size={12} aria-hidden />
              {t('proofread.apply', { count: chosen.size })}
            </GlassButton>
          )}
        </>
      }
    >
      <blockquote className="max-h-32 overflow-y-auto rounded-nb-sm border-l-2 border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] px-3 py-2 text-[12px] leading-relaxed text-nb-text-2">
        {request?.paragraph.replace(/\ufffc/g, '…')}
      </blockquote>

      <div className="mt-3 min-h-[80px]">
        {corrections === null ? (
          !error && (
            <p className="flex h-[80px] items-center justify-center text-[12px] text-nb-text-3">
              {running ? t('proofread.checking') : t('proofread.empty')}
            </p>
          )
        ) : corrections.length === 0 ? (
          <p className="flex h-[80px] items-center justify-center text-[12px] text-nb-text-3">
            {t('proofread.clean')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {corrections.map((correction, index) => (
              <li key={`${correction.index}-${correction.original}`}>
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-nb-sm px-2 py-1.5',
                    'hover:bg-[var(--nb-hover)]',
                    !chosen.has(index) && 'opacity-55',
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-[3px] accent-[var(--nb-accent)]"
                    checked={chosen.has(index)}
                    onChange={() => toggle(index)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-[13px] leading-snug">
                      <span className="text-nb-text-3 line-through">
                        {correction.original}
                      </span>
                      <ArrowRight size={11} className="text-nb-text-3" aria-hidden />
                      <span className="font-medium text-nb-text">
                        {correction.replacement || t('proofread.remove')}
                      </span>
                    </span>
                    {correction.reason && (
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-nb-text-3">
                        {correction.reason}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
