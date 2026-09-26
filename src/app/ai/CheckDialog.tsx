/**
 * Check & correct: every way of asking a model to fix what was written, in one
 * place.
 *
 * It began as two dialogs — "Rewrite & correct" for the whole note and "Check
 * this paragraph" for the line at the caret — which asked the same question
 * ("what should I fix?") in two different shapes. Here the first step is
 * choosing the scope and the depth, as a set of cards that each say what they
 * will do, and the second is the review. The review is where the safety lives:
 *
 * - Nothing writes until Apply, and what it writes is only what is ticked.
 * - A whole-note rewrite is shown block by block, before and after. The
 *   "before" is the Markdown the model was actually shown, not a re-render of
 *   the note — if those two ever disagreed, the diff would be lying about what
 *   the model saw.
 * - Paragraph corrections go back through the editor as one transaction, and
 *   are refused if the paragraph changed while the model was reading it.
 */
import {
  ArrowLeft,
  ArrowRight,
  Check,
  GraduationCap,
  Loader2,
  MessageSquareText,
  PenLine,
  Pilcrow,
  SpellCheck2,
  Sparkles,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChoiceGroup, Dialog, FieldNote, GlassButton } from '@/components/glass';
import {
  proposalMarkdown,
  type ProofreadCorrection,
  type RewriteMode,
  type RewriteResult,
} from '@/lib/ai';
import type { RewriteProposal } from '@/lib/schema';
import {
  applyRewriteCommand,
  proofreadCommand,
  proposeRewriteCommand,
} from '@/lib/commands';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import {
  applyParagraphCorrections,
  paragraphAtCaret,
  type ParagraphTarget,
} from '@/editor/commandBridge';
import { AiDialogStatus } from './AiDisclosure';
import { aiErrorMessage } from './aiErrorMessage';
import { AiRichText } from './AiRichText';
import { useAiAvailability } from './useAiAvailability';

type Task = 'paragraph' | RewriteMode;

const NOTE_TASKS: { value: RewriteMode; icon: LucideIcon }[] = [
  { value: 'light', icon: SpellCheck2 },
  { value: 'full', icon: PenLine },
  // Shown always, not only after an import. A student can decide to
  // study-ify any note, and an option that appears sometimes reads as a bug
  // rather than as a feature they have not unlocked.
  { value: 'study', icon: GraduationCap },
  { value: 'custom', icon: MessageSquareText },
];

const TASK_LABEL: Record<Task, string> = {
  paragraph: 'check.paragraph',
  light: 'ai.modeLight',
  full: 'ai.modeFull',
  study: 'ai.modeStudy',
  custom: 'ai.modeCustom',
};

export function CheckDialog() {
  const { t } = useTranslation();
  const rewriteOpen = useUiStore((state) => state.aiRewriteOpen);
  const setRewriteOpen = useUiStore((state) => state.setAiRewriteOpen);
  const pendingMode = useUiStore((state) => state.pendingRewriteMode);
  const setPendingMode = useUiStore((state) => state.setPendingRewriteMode);
  const proofreadRequest = useUiStore((state) => state.proofreadRequest);
  const closeProofread = useUiStore((state) => state.closeProofread);
  const note = useEditorStore((state) => state.note);
  const running = useAiStore((state) => state.running);

  const open = rewriteOpen || proofreadRequest !== null;

  const [task, setTask] = useState<Task>('light');
  const [paragraph, setParagraph] = useState<ParagraphTarget | null>(null);
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState('');
  // Whole-note review.
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  // Paragraph review.
  const [corrections, setCorrections] = useState<ProofreadCorrection[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());

  const feature = task === 'paragraph' ? 'proofread' : 'rewrite';
  const availability = useAiAvailability(feature, open);
  const busy = running === 'rewrite' || running === 'proofread';

  function clearReview(): void {
    setResult(null);
    setAccepted(new Set());
    setCorrections(null);
    setChosen(new Set());
    setError('');
  }

  // A review is only meaningful against the note it was made from, so every
  // opening — and every note change — starts from the choice again.
  const opened = useRef(false);
  useEffect(() => {
    clearReview();
    if (!open) {
      opened.current = false;
      return;
    }
    const firstOpen = !opened.current;
    opened.current = true;

    // "Check paragraph" from the menu or the editor: the student already said
    // which paragraph by putting the caret in it, so it runs straight away.
    if (proofreadRequest) {
      setParagraph(proofreadRequest);
      setTask('paragraph');
      void check(proofreadRequest);
      return;
    }
    if (!firstOpen) return;
    setParagraph(paragraphAtCaret());
    // Read once and clear: something opened this dialog on the student's
    // behalf — import, so far — and asked for a mode.
    if (pendingMode) {
      setTask(pendingMode);
      setPendingMode(null);
      return;
    }
    // Study mode is never inherited. Every other mode promises the author's
    // words survive, so leaving one selected between opens is a convenience;
    // this one rewrites them. Someone arriving through "Check & correct"
    // expects correction, and finding the note reshaped instead — because of
    // a choice made for a different note last week — is the surprise worth a
    // second click. A paragraph from last time is gone with its caret.
    setTask((current) =>
      current === 'study' || current === 'paragraph' ? 'light' : current,
    );
    // `pendingMode` and `check` are deliberately absent: this runs when the
    // dialog opens or the note changes, and clearing the pending mode inside
    // it must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id, open, proofreadRequest]);

  function choose(next: Task): void {
    if (next === task) return;
    setTask(next);
    clearReview();
  }

  async function check(target: ParagraphTarget): Promise<void> {
    // The previous corrections stay on screen while a re-check runs, so the
    // review does not blink back to the choice and return.
    setError('');
    const signal = beginRun('proofread');
    const outcome = await proofreadCommand(
      { paragraph: target.paragraph, courseId: note?.courseId ?? null },
      { signal },
    );
    endRun('proofread', signal);
    if (!outcome.ok) {
      if (outcome.code === 'cancelled') return;
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

  async function propose(mode: RewriteMode): Promise<void> {
    if (!note) return;
    setError('');
    setResult(null);
    const signal = beginRun('rewrite');
    const response = await proposeRewriteCommand(
      { noteId: note.id, mode, instruction },
      { signal },
    );
    endRun('rewrite', signal);
    if (!response.ok) {
      // A cancel is not a failure: the student pressed the button and knows
      // what happened.
      if (response.code !== 'cancelled') setError(aiErrorMessage(response, t));
      return;
    }
    setResult(response.value);
    // Everything ticked by default. The model was asked to propose only what
    // it wanted changed, so the common case is "yes, all of that" — and the
    // opposite default would make a good rewrite a chore to accept.
    setAccepted(new Set(response.value.proposal.blocks.map((_, index) => index)));
  }

  function run(): void {
    if (task === 'paragraph') {
      if (paragraph) void check(paragraph);
    } else {
      void propose(task);
    }
  }

  /** One close for Escape, Cancel, and the status pill on its way to Settings
   * — a dialog left open behind that window is a window you cannot reach. */
  function close(): void {
    cancelRun('rewrite');
    cancelRun('proofread');
    setRewriteOpen(false);
    closeProofread();
  }

  async function applyRewrite(): Promise<void> {
    if (!note || !result) return;
    setApplying(true);
    const response = await applyRewriteCommand({
      noteId: note.id,
      proposal: result.proposal,
      accepted: [...accepted],
    });
    setApplying(false);
    if (response.ok) close();
    else setError(response.message);
  }

  function applyCorrections(): void {
    if (!corrections || !paragraph) return;
    const kept = corrections.filter((_, index) => chosen.has(index));
    if (!applyParagraphCorrections(paragraph, kept)) {
      setError(t('proofread.changed'));
      return;
    }
    close();
  }

  const blocks = result?.proposal.blocks ?? [];
  const reviewing = result !== null || corrections !== null;
  const canRun =
    availability.available &&
    !busy &&
    (task === 'paragraph'
      ? paragraph !== null
      : note !== null && (task !== 'custom' || instruction.trim().length > 0));

  return (
    <Dialog
      open={open}
      onClose={close}
      title={reviewing ? t(TASK_LABEL[task]) : t('check.title')}
      description={reviewing ? undefined : t('check.intro')}
      // The sheet grows when there are two columns of prose to compare.
      size={result && blocks.length ? 'xl' : 'lg'}
      headerAction={<AiDialogStatus feature={feature} onLeave={close} />}
      footer={
        <Footer
          reviewing={reviewing}
          busy={busy}
          canRun={canRun}
          task={task}
          onBack={clearReview}
          onClose={close}
          onRun={run}
          rewrite={
            result && blocks.length
              ? {
                  total: blocks.length,
                  accepted: accepted.size,
                  applying,
                  onToggleAll: () =>
                    setAccepted(
                      accepted.size === blocks.length
                        ? new Set()
                        : new Set(blocks.map((_, index) => index)),
                    ),
                  onApply: () => void applyRewrite(),
                }
              : undefined
          }
          paragraph={
            corrections && corrections.length
              ? { chosen: chosen.size, onApply: applyCorrections }
              : undefined
          }
        />
      }
    >
      {!reviewing ? (
        <TaskPicker
          task={task}
          paragraph={paragraph}
          instruction={instruction}
          onChoose={choose}
          onInstruction={setInstruction}
          busy={busy}
        />
      ) : task === 'paragraph' ? (
        <ParagraphReview
          paragraph={paragraph}
          corrections={corrections ?? []}
          chosen={chosen}
          onToggle={(index) => setChosen((current) => toggled(current, index))}
        />
      ) : (
        result && (
          <RewriteReview
            result={result}
            accepted={accepted}
            onToggle={(index) => setAccepted((current) => toggled(current, index))}
          />
        )
      )}

      {busy && !reviewing && (
        <p className="mt-3 flex items-center justify-center gap-2 text-[12px] text-nb-text-3">
          <Loader2 size={13} className="animate-spin" aria-hidden />
          {task === 'paragraph' ? t('proofread.checking') : t('check.reading')}
        </p>
      )}
      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}

function toggled(current: Set<number>, index: number): Set<number> {
  const next = new Set(current);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

function TaskPicker({
  task,
  paragraph,
  instruction,
  onChoose,
  onInstruction,
  busy,
}: {
  task: Task;
  paragraph: ParagraphTarget | null;
  instruction: string;
  onChoose(task: Task): void;
  onInstruction(value: string): void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <ChoiceGroup<Task>
        label={t('check.what')}
        value={task}
        onChange={onChoose}
        disabled={busy}
        sections={[
          {
            label: t('check.scopeParagraph'),
            columns: 1,
            options: [
              {
                value: 'paragraph',
                icon: Pilcrow,
                title: t('check.paragraph'),
                description: t('check.paragraphHint'),
                disabled: !paragraph,
                detail: paragraph ? (
                  <span className="mt-2 line-clamp-2 border-l-2 border-[var(--nb-divider)] pl-2.5 text-[12px] italic leading-relaxed text-nb-text-2">
                    {paragraph.paragraph.replace(/\ufffc/g, '…')}
                  </span>
                ) : (
                  <span className="mt-1.5 block text-[11.5px] text-nb-text-3">
                    {t('proofread.noParagraph')}
                  </span>
                ),
              },
            ],
          },
          {
            label: t('check.scopeNote'),
            columns: 2,
            options: NOTE_TASKS.map(({ value, icon }) => ({
              value,
              icon,
              title: t(TASK_LABEL[value]),
              description: t(`check.${value}Hint`),
              badge: value === 'study' ? t('check.rewords') : undefined,
            })),
          },
        ]}
      />

      {/* The other options promise to keep the author's words. This one does
          not, and that difference is the whole safety story — so it is stated
          where the choice is made, not in a tooltip. */}
      {task === 'study' && (
        <p className="flex items-start gap-2 rounded-nb-sm border border-[color-mix(in_srgb,var(--nb-warn)_30%,var(--nb-divider))] bg-[color-mix(in_srgb,var(--nb-warn)_7%,transparent)] px-3 py-2 text-[12px] leading-relaxed text-nb-text-2">
          <TriangleAlert
            size={13}
            className="mt-[3px] shrink-0 text-[var(--nb-warn)]"
            aria-hidden
          />
          {t('ai.modeStudyHint')}
        </p>
      )}
      {task === 'custom' && (
        <input
          data-autofocus
          value={instruction}
          onChange={(event) => onInstruction(event.target.value)}
          placeholder={t('ai.instructionPlaceholder')}
          aria-label={t('ai.instruction')}
          className="h-9 rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--nb-accent-ring)]"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reviewing
// ---------------------------------------------------------------------------

function ParagraphReview({
  paragraph,
  corrections,
  chosen,
  onToggle,
}: {
  paragraph: ParagraphTarget | null;
  corrections: ProofreadCorrection[];
  chosen: Set<number>;
  onToggle(index: number): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <blockquote className="max-h-32 overflow-y-auto rounded-nb-sm border-l-2 border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] px-3 py-2 text-[12px] leading-relaxed text-nb-text-2">
        {paragraph?.paragraph.replace(/￼/g, '…')}
      </blockquote>
      {corrections.length === 0 ? (
        <Clean text={t('proofread.clean')} />
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
                  onChange={() => onToggle(index)}
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
  );
}

function RewriteReview({
  result,
  accepted,
  onToggle,
}: {
  result: RewriteResult;
  accepted: Set<number>;
  onToggle(index: number): void;
}) {
  const { t } = useTranslation();
  const blocks = result.proposal.blocks;
  return (
    <div className="flex flex-col gap-3">
      {result.summary && (
        <div className="flex items-start gap-2 rounded-nb-xs bg-[var(--nb-inset-surface)] px-3 py-2 text-[12px] leading-relaxed text-nb-text-2">
          <Sparkles
            size={13}
            aria-hidden
            className="mt-[3px] shrink-0 text-[var(--nb-accent)]"
          />
          <p>{result.summary}</p>
        </div>
      )}
      {blocks.length ? (
        <ul className="flex flex-col gap-2">
          {blocks.map((block, index) => (
            <BlockDiff
              key={index}
              before={result.before[block.index] ?? ''}
              block={block}
              accepted={accepted.has(index)}
              onToggle={() => onToggle(index)}
            />
          ))}
        </ul>
      ) : (
        <Clean text={t('ai.noChanges')} />
      )}
    </div>
  );
}

function Clean({ text }: { text: string }) {
  return (
    <p className="flex flex-col items-center gap-2 py-8 text-center text-[12.5px] text-nb-text-2">
      <span className="grid size-9 place-items-center rounded-full bg-[color-mix(in_srgb,var(--nb-success)_12%,transparent)] text-[var(--nb-success)]">
        <Check size={16} aria-hidden />
      </span>
      {text}
    </p>
  );
}

function BlockDiff({
  before,
  block,
  accepted,
  onToggle,
}: {
  before: string;
  block: RewriteProposal['blocks'][number];
  accepted: boolean;
  onToggle(): void;
}) {
  const { t } = useTranslation();
  const after = block.action === 'remove' ? '' : proposalMarkdown(block.node);

  return (
    <li
      className={cn(
        'rounded-nb-sm border bg-[var(--nb-paper)] p-3 transition-colors duration-[var(--nb-t-fast)]',
        accepted
          ? 'border-[color-mix(in_srgb,var(--nb-accent)_60%,var(--nb-divider))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--nb-accent)_12%,transparent)]'
          : 'border-[var(--nb-divider)]',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="rounded-full bg-[var(--nb-hover)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-nb-text-3">
          {t(`ai.action_${block.action}`)}
        </span>
        {block.rationale && (
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-nb-text-2">
            {block.rationale}
          </p>
        )}
        <button
          type="button"
          aria-label={accepted ? t('ai.reject') : t('ai.accept')}
          aria-pressed={accepted}
          onClick={onToggle}
          className={cn(
            'ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
            accepted
              ? 'border-[color-mix(in_srgb,var(--nb-success)_35%,var(--nb-divider))] bg-[color-mix(in_srgb,var(--nb-success)_10%,transparent)] text-[var(--nb-success)]'
              : 'border-[var(--nb-divider)] bg-[var(--nb-hover)] text-nb-text-3 hover:text-nb-text',
          )}
        >
          {accepted ? <Check size={12} /> : <X size={12} />}
          {accepted ? t('ai.included') : t('ai.excluded')}
        </button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {block.action !== 'insert' && (
          <Side label={t('ai.before')} text={before} tone="removed" />
        )}
        {block.action !== 'remove' && (
          <Side label={t('ai.after')} text={after} tone="added" />
        )}
      </div>
    </li>
  );
}

function Side({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: 'removed' | 'added';
}) {
  return (
    <section className="min-w-0">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-nb-text-3">
        {label}
      </p>
      <div
        className={cn(
          'min-h-full rounded-nb-xs border p-3',
          tone === 'removed'
            ? 'border-[color-mix(in_srgb,var(--nb-danger)_22%,var(--nb-divider))] bg-[color-mix(in_srgb,var(--nb-danger)_5%,transparent)]'
            : 'border-[color-mix(in_srgb,var(--nb-success)_22%,var(--nb-divider))] bg-[color-mix(in_srgb,var(--nb-success)_5%,transparent)]',
        )}
      >
        <AiRichText markdown={text} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

/**
 * The primary action follows the stage. There is one thing to do before a
 * review exists and a different one after, and showing both at once put two
 * accent buttons on screen with the live one buried in the body.
 */
function Footer({
  reviewing,
  busy,
  canRun,
  task,
  onBack,
  onClose,
  onRun,
  rewrite,
  paragraph,
}: {
  reviewing: boolean;
  busy: boolean;
  canRun: boolean;
  task: Task;
  onBack(): void;
  onClose(): void;
  onRun(): void;
  rewrite?: {
    total: number;
    accepted: number;
    applying: boolean;
    onToggleAll(): void;
    onApply(): void;
  };
  paragraph?: { chosen: number; onApply(): void };
}) {
  const { t } = useTranslation();

  if (!reviewing) {
    return (
      <>
        <GlassButton
          size="sm"
          onClick={() => {
            if (busy) {
              cancelRun('rewrite');
              cancelRun('proofread');
            } else onClose();
          }}
        >
          {busy ? t('ai.cancel') : t('common.cancel')}
        </GlassButton>
        <GlassButton size="sm" variant="accent" disabled={!canRun} onClick={onRun}>
          {busy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : task === 'paragraph' ? (
            <SpellCheck2 size={12} aria-hidden />
          ) : (
            <Sparkles size={12} aria-hidden />
          )}
          {busy
            ? t('ai.running')
            : task === 'paragraph'
              ? t('check.runParagraph')
              : t('ai.propose')}
        </GlassButton>
      </>
    );
  }

  const back = (
    <GlassButton size="sm" variant="ghost" onClick={onBack} disabled={busy}>
      <ArrowLeft size={12} aria-hidden />
      {t('check.back')}
    </GlassButton>
  );

  if (rewrite) {
    return (
      <>
        {back}
        <GlassButton size="sm" variant="ghost" onClick={rewrite.onToggleAll}>
          {rewrite.accepted === rewrite.total ? t('ai.rejectAll') : t('ai.acceptAll')}
        </GlassButton>
        <span className="mr-auto text-[11px] text-nb-text-3">
          {t('ai.acceptedCount', { count: rewrite.accepted, total: rewrite.total })}
        </span>
        <GlassButton size="sm" onClick={onClose}>
          {t('common.cancel')}
        </GlassButton>
        <GlassButton
          size="sm"
          variant="accent"
          disabled={!rewrite.accepted || rewrite.applying}
          onClick={rewrite.onApply}
        >
          {t('ai.apply')}
        </GlassButton>
      </>
    );
  }

  return (
    <>
      <span className="mr-auto">{back}</span>
      {task === 'paragraph' && (
        <GlassButton size="sm" variant="ghost" disabled={busy} onClick={onRun}>
          {busy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <SpellCheck2 size={12} aria-hidden />
          )}
          {busy ? t('ai.running') : t('proofread.checkAgain')}
        </GlassButton>
      )}
      {paragraph ? (
        <GlassButton
          size="sm"
          variant="accent"
          disabled={paragraph.chosen === 0 || busy}
          onClick={paragraph.onApply}
        >
          <Check size={12} aria-hidden />
          {t('proofread.apply', { count: paragraph.chosen })}
        </GlassButton>
      ) : (
        <GlassButton size="sm" variant="accent" onClick={onClose}>
          {t('common.close')}
        </GlassButton>
      )}
    </>
  );
}
