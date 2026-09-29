import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useTranslation } from 'react-i18next';
import { PenLine, SpellCheck2 } from 'lucide-react';
import { ChoiceGroup, Dialog, GlassButton } from '@/components/glass';
import { AiDialogStatus } from '@/app/ai/AiDisclosure';
import { Sources } from '@/app/ai/Sources';
import { useAiAvailability } from '@/app/ai/useAiAvailability';
import { aiErrorMessage } from '@/app/ai/aiErrorMessage';
import { applyEditorAiSelectionCommand } from '@/lib/commands/aiCommands';
import { proposeSelectionAssistCommand } from '@/lib/commands/selectionAssistCommands';
import { useEditorStore } from '@/lib/state/editorStore';
import { applySelectionText, type SelectionTarget } from './selectionTarget';

export interface SelectionAssistRequest {
  mode: 'correct' | 'rewrite';
  target: SelectionTarget;
  noteId: string | undefined;
}

export function SelectionAssistDialog({
  editor,
  request,
  onClose,
}: {
  editor: Editor;
  request: SelectionAssistRequest;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(request.mode);
  const [proposal, setProposal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const note = useEditorStore((state) => state.note);
  const feature = mode === 'correct' ? 'proofread' : 'rewrite';
  const availability = useAiAvailability(feature);
  const close = useCallback(() => {
    controller.current?.abort();
    onClose();
  }, [onClose]);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (note?.id !== request.noteId) close();
  }, [note?.id, request.noteId, close]);

  async function generate() {
    const run = new AbortController();
    controller.current = run;
    setBusy(true);
    setError('');
    const result = await proposeSelectionAssistCommand(
      { text: request.target.text, mode },
      { signal: run.signal },
    );
    if (run.signal.aborted) return;
    setBusy(false);
    if (result.ok) setProposal(result.value);
    else setError(aiErrorMessage(result, t));
  }

  return (
    <Dialog
      open
      onClose={close}
      title={t('contextMenu.assistTitle')}
      description={t('contextMenu.assistDescription')}
      size={proposal === null ? 'lg' : 'xl'}
      headerAction={<AiDialogStatus feature={feature} onLeave={close} />}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <GlassButton variant="ghost" onClick={close}>
            {t('common.cancel')}
          </GlassButton>
          {proposal === null ? (
            <GlassButton
              disabled={busy || !availability.available}
              onClick={() => void generate()}
            >
              {t(busy ? 'contextMenu.generating' : 'contextMenu.generate')}
            </GlassButton>
          ) : (
            <GlassButton
              disabled={busy}
              onClick={() => {
                if (!request.noteId || proposal === null) return;
                setBusy(true);
                void applyEditorAiSelectionCommand(request.noteId, () =>
                  applySelectionText(editor, request.target, proposal),
                ).then((result) => {
                  setBusy(false);
                  if (result.ok) close();
                  else setError(result.message);
                });
              }}
            >
              {t('contextMenu.apply')}
            </GlassButton>
          )}
        </div>
      }
    >
      <Sources count={1} titles={[note?.title || t('contextMenu.selection')]} />
      {proposal === null && (
        <ChoiceGroup
          label={t('contextMenu.assistTitle')}
          value={mode}
          disabled={busy}
          onChange={(next) => {
            setMode(next);
            setError('');
          }}
          options={[
            {
              value: 'correct',
              title: t('contextMenu.correct'),
              description: t('contextMenu.correctDescription'),
              icon: SpellCheck2,
            },
            {
              value: 'rewrite',
              title: t('contextMenu.rewrite'),
              description: t('contextMenu.rewriteDescription'),
              icon: PenLine,
            },
          ]}
        />
      )}
      <div className={proposal === null ? 'mt-4' : 'grid gap-4 sm:grid-cols-2'}>
        {[
          { label: t('contextMenu.original'), text: request.target.text },
          ...(proposal === null
            ? []
            : [{ label: t('contextMenu.proposal'), text: proposal }]),
        ].map((part) => (
          <section key={part.label}>
            <h3 className="mb-2 text-xs font-medium text-nb-text-3">{part.label}</h3>
            <p className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] p-3 text-[13px] leading-relaxed">
              {part.text}
            </p>
          </section>
        ))}
      </div>
      <p className="mt-3 text-xs text-nb-text-3">{t('contextMenu.formattingNote')}</p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--nb-danger)]">
          {error}
        </p>
      )}
    </Dialog>
  );
}
