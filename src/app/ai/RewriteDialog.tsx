/**
 * Rewrite & correct, with the diff gate.
 *
 * The gate is the feature. A model that edits a note directly is a model you
 * have to proofread afterwards against a version you can no longer see; a model
 * that proposes block-by-block is one you can skim in ten seconds. Nothing here
 * writes until the user presses Apply, and what it writes is only the ticked
 * blocks.
 *
 * The "before" text is the Markdown the model was actually shown, not a
 * re-render of the note — if those two ever disagreed, the diff would be lying
 * about what the model saw.
 */
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton, GlassSegmentedControl } from '@/components/glass';
import { proposalMarkdown, type RewriteMode, type RewriteResult } from '@/lib/ai';
import type { RewriteProposal } from '@/lib/schema';
import { applyRewriteCommand, proposeRewriteCommand } from '@/lib/commands';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { AiStatusPill } from './AiStatusPill';
import { AiRichText } from './AiRichText';
import { useAiAvailability } from './useAiAvailability';

export function RewriteDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.aiRewriteOpen);
  const setOpen = useUiStore((state) => state.setAiRewriteOpen);
  const note = useEditorStore((state) => state.note);
  const running = useAiStore((state) => state.running) === 'rewrite';
  const availability = useAiAvailability('rewrite');

  const [mode, setMode] = useState<RewriteMode>('light');
  const [instruction, setInstruction] = useState('');
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);

  // A proposal is only meaningful against the note it was made from. Opening
  // the dialog on a different note must not offer to apply the previous one.
  useEffect(() => {
    setResult(null);
    setAccepted(new Set());
    setError('');
  }, [note?.id, open]);

  async function run() {
    if (!note) return;
    setError('');
    setResult(null);
    const signal = beginRun('rewrite');
    const response = await proposeRewriteCommand(
      { noteId: note.id, mode, instruction },
      { signal },
    );
    endRun('rewrite');

    if (!response.ok) {
      setError(
        response.code === 'not_supported' ? t('ai.notConfiguredHint') : response.message,
      );
      return;
    }
    setResult(response.value);
    // Everything ticked by default. The model was asked to propose only what it
    // wanted changed, so the common case is "yes, all of that" — and the
    // opposite default would make a good rewrite a chore to accept.
    setAccepted(new Set(response.value.proposal.blocks.map((_, index) => index)));
  }

  async function apply() {
    if (!note || !result) return;
    setApplying(true);
    const response = await applyRewriteCommand({
      noteId: note.id,
      proposal: result.proposal,
      accepted: [...accepted],
    });
    setApplying(false);
    if (response.ok) setOpen(false);
    else setError(response.message);
  }

  function toggle(index: number) {
    setAccepted((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const blocks = result?.proposal.blocks ?? [];

  const staged = blocks.length > 0;

  return (
    <Dialog
      open={open}
      onClose={() => {
        cancelRun('rewrite');
        setOpen(false);
      }}
      title={t('ai.rewrite')}
      description={t('ai.rewriteIntro')}
      // The sheet grows when there is something to compare. Before that it is
      // one control, and 900px of empty paper around it reads as a mistake;
      // after it, two columns of prose need every pixel.
      size={staged ? 'xl' : 'md'}
      headerAction={<AiStatusPill feature="rewrite" compact />}
      footer={
        /* The primary action follows the stage. There is one thing to do before
           a proposal exists and a different one after, and showing both at once
           put two accent buttons on screen with the live one buried in the body
           above the footer that held the dead one. */
        staged ? (
          <>
            <GlassButton
              size="sm"
              variant="ghost"
              onClick={() =>
                setAccepted(
                  accepted.size === blocks.length
                    ? new Set()
                    : new Set(blocks.map((_, index) => index)),
                )
              }
            >
              {accepted.size === blocks.length ? t('ai.rejectAll') : t('ai.acceptAll')}
            </GlassButton>
            <span className="mr-auto text-[11px] text-nb-text-3">
              {t('ai.acceptedCount', { count: accepted.size, total: blocks.length })}
            </span>
            <GlassButton size="sm" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </GlassButton>
            <GlassButton
              size="sm"
              variant="accent"
              disabled={!accepted.size || applying}
              onClick={() => void apply()}
            >
              {t('ai.apply')}
            </GlassButton>
          </>
        ) : (
          <>
            <GlassButton
              size="sm"
              onClick={() => {
                cancelRun('rewrite');
                setOpen(false);
              }}
            >
              {running ? t('ai.cancel') : t('common.cancel')}
            </GlassButton>
            <GlassButton
              size="sm"
              variant="accent"
              disabled={
                !note ||
                !availability.available ||
                running ||
                (mode === 'custom' && !instruction.trim())
              }
              onClick={() => void run()}
            >
              {running && <Loader2 size={12} className="animate-spin" />}
              {running ? t('ai.running') : t('ai.propose')}
            </GlassButton>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <GlassSegmentedControl<RewriteMode>
          label={t('ai.rewriteMode')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'light', label: t('ai.modeLight') },
            { value: 'full', label: t('ai.modeFull') },
            { value: 'custom', label: t('ai.modeCustom') },
          ]}
        />
        {mode === 'custom' && (
          <input
            data-autofocus
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={t('ai.instructionPlaceholder')}
            aria-label={t('ai.instruction')}
            className="h-8 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
          />
        )}

        {result?.summary && (
          <div className="flex items-start gap-2 rounded-nb-xs bg-[var(--nb-inset-surface)] px-3 py-2 text-[12px] leading-relaxed text-nb-text-2">
            <Sparkles
              size={13}
              aria-hidden
              className="mt-[3px] shrink-0 text-[var(--nb-accent)]"
            />
            <p>{result.summary}</p>
          </div>
        )}
        {error && <p className="text-[12px] text-[var(--nb-danger)]">{error}</p>}

        {result &&
          (blocks.length ? (
            <ul className="flex flex-col gap-2">
              {blocks.map((block, index) => (
                <BlockDiff
                  key={index}
                  before={result.before[block.index] ?? ''}
                  block={block}
                  accepted={accepted.has(index)}
                  onToggle={() => toggle(index)}
                />
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-[12px] text-nb-text-3">
              {t('ai.noChanges')}
            </p>
          ))}
      </div>
    </Dialog>
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
