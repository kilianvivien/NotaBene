/**
 * What does this word mean, and put it in a box.
 *
 * The feature is a lecture-speed one, so the dialog runs the lookup the moment
 * it opens rather than waiting for a button: the student already told it which
 * word by selecting it, and making them confirm that would double the length
 * of an interaction whose whole value is that it is short.
 *
 * The term stays editable anyway, for the two cases the selection gets wrong —
 * a word caught mid-inflection, and no selection at all because the command
 * came from the menu. Editing it and pressing Return looks the word up again
 * against the same passage, which is the right thing: the sentence has not
 * changed just because the student fixed a plural.
 *
 * Nothing is written until Insert. The definition is a model's answer sitting
 * in a dialog until a student decides it is right, which is the same gate every
 * other AI feature here puts in front of the note.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookA, Loader2, Search, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, FieldNote, GlassButton } from '@/components/glass';
import { AiDialogStatus } from '@/app/ai/AiDisclosure';
import { useAiAvailability } from '@/app/ai/useAiAvailability';
import { defineTermCommand } from '@/lib/commands';
import type { AiDefinitionResponse } from '@/lib/schema';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';

export function DefineDialog({
  request,
  noteTitle,
  onClose,
  onInsert,
}: {
  /** The word and the passage it came from, or `null` when closed. */
  request: { term: string; context: string } | null;
  noteTitle: string;
  onClose(): void;
  /** The editor owns the caret, so the dialog hands over a definition rather
   * than a transaction. */
  onInsert(definition: AiDefinitionResponse): void;
}) {
  const { t } = useTranslation();
  const running = useAiStore((state) => state.running) === 'define';

  // Refreshed only while the dialog is open. It is mounted with the editor —
  // that is, on every note — and a closed dialog has no reason to ask a local
  // runtime anything.
  const availability = useAiAvailability('define', request !== null);

  const [term, setTerm] = useState('');
  const [result, setResult] = useState<AiDefinitionResponse | null>(null);
  const [error, setError] = useState('');

  // Which request the automatic lookup has already fired for. An object
  // identity rather than the word itself, so looking up the same term twice in
  // a row still runs — and so a re-render, or a second mount in development,
  // does not spend a second call on the first one.
  const looked = useRef<object | null>(null);

  useEffect(() => {
    if (!request) {
      looked.current = null;
      return;
    }
    if (looked.current === request) return;
    looked.current = request;
    setTerm(request.term);
    setResult(null);
    setError('');
    if (request.term.trim()) void look(request.term, request.context);
    // `look` is recreated every render and closes over nothing that matters
    // here; the ref above is what makes this fire once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  async function look(word: string, context: string): Promise<void> {
    const looking = word.trim();
    if (!looking) return;
    setError('');
    const signal = beginRun('define');
    const outcome = await defineTermCommand(
      { term: looking, context, noteTitle },
      { signal },
    );
    endRun('define', signal);

    if (!outcome.ok) {
      if (outcome.code === 'cancelled') return;
      setResult(null);
      setError(
        outcome.code === 'not_supported'
          ? t('ai.notConfiguredHint')
          : outcome.code === 'invalid_input'
            ? t('define.tooLong')
            : outcome.message,
      );
      return;
    }
    setResult(outcome.value);
  }

  // Stable, because `ModalOverlay` holds it for as long as the dialog is open
  // and a dialog that hands it a new function every render is a dialog that
  // makes it tear its focus handling down and set it up again every render.
  const close = useCallback((): void => {
    cancelRun('define');
    onClose();
  }, [onClose]);

  const open = request !== null;
  const canLook = Boolean(term.trim()) && availability.available && !running;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('define.title')}
      description={t('define.hint')}
      size="md"
      headerAction={<AiDialogStatus feature="define" onLeave={close} />}
      footer={
        <>
          {running ? (
            <GlassButton size="sm" onClick={() => cancelRun('define')}>
              {t('ai.cancel')}
            </GlassButton>
          ) : (
            <GlassButton size="sm" variant="ghost" onClick={close}>
              {t('common.cancel')}
            </GlassButton>
          )}
          <GlassButton
            size="sm"
            variant={result ? 'ghost' : 'accent'}
            disabled={!canLook}
            onClick={() => void look(term, request?.context ?? '')}
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Search size={12} />
            )}
            {running
              ? t('ai.running')
              : result
                ? t('define.lookUpAgain')
                : t('define.lookUp')}
          </GlassButton>
          {result && (
            <GlassButton
              size="sm"
              variant="accent"
              // `close`, not `onClose`: a second lookup can still be in flight
              // behind a result the student has decided to keep, and leaving it
              // running would spend a request nobody is going to read — and
              // leave the spinner claiming the feature is busy.
              onClick={() => {
                onInsert(result);
                close();
              }}
            >
              <BookA size={12} aria-hidden />
              {t('define.insertCallout')}
            </GlassButton>
          )}
        </>
      }
    >
      <div className="relative flex items-center">
        <Search
          size={13}
          aria-hidden
          className="pointer-events-none absolute left-2.5 text-nb-text-3"
        />
        <input
          data-autofocus
          type="text"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && canLook) {
              event.preventDefault();
              void look(term, request?.context ?? '');
            }
          }}
          placeholder={t('define.placeholder')}
          aria-label={t('define.term')}
          className="w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] py-2 pl-7 pr-2.5 text-[13px] text-nb-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--nb-accent-ring)]"
        />
      </div>

      {/* The preview is shaped like the callout it becomes, so Insert holds no
          surprises about what lands in the note. It goes away entirely while an
          error is showing: an empty box above "add a key in Settings" is a
          placeholder for something that is not coming. */}
      {(result || !error) && (
        <div className="mt-2 min-h-[110px] rounded-nb-sm border border-[var(--nb-divider)] p-3">
          {result ? (
            <>
              <p className="text-[13px] leading-relaxed text-nb-text">
                <strong className="font-semibold">{result.term}</strong>
                {' — '}
                {result.definition}
              </p>
              {result.inContext && (
                <p className="mt-1.5 text-[12px] italic leading-relaxed text-nb-text-2">
                  {result.inContext}
                </p>
              )}
              {result.uncertain && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] text-nb-text-3">
                  <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
                  {t('define.uncertain')}
                </p>
              )}
            </>
          ) : (
            <p className="flex h-full items-center justify-center px-6 text-center text-[12px] text-nb-text-3">
              {running ? t('define.looking') : t('define.empty')}
            </p>
          )}
        </div>
      )}

      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
