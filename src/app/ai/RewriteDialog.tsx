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
import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, GlassSegmentedControl, ModalOverlay } from '@/components/glass';
import { proposalMarkdown, type RewriteMode, type RewriteResult } from '@/lib/ai';
import type { RewriteProposal } from '@/lib/schema';
import { applyRewriteCommand, proposeRewriteCommand } from '@/lib/commands';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { AiStatusPill } from './AiStatusPill';
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
        response.code === 'not_supported'
          ? t('ai.notConfiguredHint')
          : response.message,
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

  return (
    <ModalOverlay
      open={open}
      onClose={() => {
        cancelRun('rewrite');
        setOpen(false);
      }}
      label={t('ai.rewrite')}
      className="w-[min(640px,92vw)]"
    >
      <div className="flex max-h-[min(640px,80vh)] w-full flex-col">
        <header className="flex items-center gap-3 border-b border-[var(--nb-divider)] p-4">
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold">
            {t('ai.rewrite')}
          </h2>
          <AiStatusPill feature="rewrite" className="max-w-[45%] shrink-0" />
        </header>

        <div className="flex flex-col gap-3 border-b border-[var(--nb-divider)] p-4">
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
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder={t('ai.instructionPlaceholder')}
              aria-label={t('ai.instruction')}
              className="h-8 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
            />
          )}
          <div className="flex items-center gap-2">
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
            {running && (
              <GlassButton size="sm" variant="ghost" onClick={() => cancelRun('rewrite')}>
                {t('ai.cancel')}
              </GlassButton>
            )}
            {result?.summary && (
              <p className="min-w-0 flex-1 truncate text-[11px] text-nb-text-3">
                {result.summary}
              </p>
            )}
          </div>
          {error && <p className="text-[12px] text-[var(--nb-danger)]">{error}</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!result ? (
            <p className="text-[12px] text-nb-text-3">{t('ai.rewriteIntro')}</p>
          ) : !blocks.length ? (
            <p className="text-[12px] text-nb-text-3">{t('ai.noChanges')}</p>
          ) : (
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
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--nb-divider)] p-3">
          {blocks.length > 0 && (
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
            </>
          )}
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
        </footer>
      </div>
    </ModalOverlay>
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
        'rounded-nb-sm border p-2 transition-colors duration-[var(--nb-t-fast)]',
        accepted
          ? 'border-[var(--nb-accent)] bg-[var(--nb-accent-soft)]'
          : 'border-[var(--nb-divider)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-[var(--nb-hover)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-nb-text-3">
          {t(`ai.action_${block.action}`)}
        </span>
        {block.rationale && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-nb-text-3">
            {block.rationale}
          </span>
        )}
        <button
          type="button"
          aria-label={accepted ? t('ai.reject') : t('ai.accept')}
          aria-pressed={accepted}
          onClick={onToggle}
          className="ml-auto rounded-nb-xs p-1 hover:bg-[var(--nb-hover)]"
        >
          {accepted ? <Check size={13} /> : <X size={13} />}
        </button>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
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
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-nb-text-3">{label}</p>
      <pre
        className={cn(
          'mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-nb-xs p-1.5',
          'font-[var(--nb-font-mono)] text-[11px] leading-snug',
          tone === 'removed'
            ? 'bg-[color-mix(in_srgb,var(--nb-danger)_12%,transparent)]'
            : 'bg-[color-mix(in_srgb,var(--nb-accent)_12%,transparent)]',
        )}
      >
        {text}
      </pre>
    </div>
  );
}
