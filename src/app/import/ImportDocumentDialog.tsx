import { FileText, LockKeyhole } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AiDialogStatus } from '@/app/ai/AiDisclosure';
import { AiRichText } from '@/app/ai/AiRichText';
import { useAiAvailability } from '@/app/ai/useAiAvailability';
import {
  Dialog,
  FieldNote,
  FieldRow,
  FieldToggle,
  GlassButton,
} from '@/components/glass';
import {
  createImportedNoteCommand,
  extractDocumentCommand,
  reformatDocumentCommand,
} from '@/lib/commands';
import type { ImportedDocument } from '@/lib/schema';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useUiStore } from '@/lib/state/uiStore';

function formatLabel(format: string): string {
  if (format === 'markdown') return 'Markdown';
  if (format === 'text') return 'Text';
  return format.toUpperCase();
}

export function ImportDocumentDialog() {
  const { t } = useTranslation();
  const source = useUiStore((state) => state.documentImportSource);
  const setSource = useUiStore((state) => state.setDocumentImportSource);
  const availability = useAiAvailability('importFormat');
  const formatting = useAiStore((state) => state.running) === 'importFormat';
  const [document, setDocument] = useState<ImportedDocument | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [keepOriginal, setKeepOriginal] = useState(true);
  // Off by default, and reset with every document: sending a file to a provider
  // is a decision, not a preference to inherit from the last import.
  const [reformat, setReformat] = useState(false);
  /** The laid-out Markdown, kept beside the original rather than replacing it
   * so switching the toggle back off is instant and always possible. */
  const [formatted, setFormatted] = useState<string | null>(null);
  const [formatNote, setFormatNote] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  useEffect(() => {
    if (!source) return;
    let active = true;
    setDocument(null);
    setError('');
    setWarning('');
    setCompleted(false);
    setKeepOriginal(true);
    setReformat(false);
    setFormatted(null);
    setFormatNote('');
    setExtracting(true);
    void extractDocumentCommand(source).then((result) => {
      if (!active) return;
      setExtracting(false);
      if (result.ok) {
        setDocument(result.value);
        return;
      }
      setError(
        result.message === 'ocr_required'
          ? t('import.ocrRequired')
          : result.message === 'unsupported_format'
            ? t('import.unsupported')
            : result.message === 'attachment_missing'
              ? t('import.attachmentMissing')
              : t('import.failed'),
      );
    });
    return () => {
      active = false;
    };
  }, [source, t]);

  function close() {
    if (creating) return;
    cancelRun('importFormat');
    setSource(null);
  }

  /**
   * Turning the toggle on runs the pass once; turning it off reverts the
   * preview without discarding the result, so a student comparing the two
   * versions is not paying for a second call each time they look.
   */
  async function toggleReformat(next: boolean) {
    if (!next) {
      cancelRun('importFormat');
      setReformat(false);
      return;
    }
    setReformat(true);
    if (!document || formatted !== null) return;

    setFormatNote('');
    setError('');
    const signal = beginRun('importFormat');
    const result = await reformatDocumentCommand(document, { signal });
    endRun('importFormat', signal);

    // Switching the toggle back off, or closing the dialog, aborts the call and
    // the command reports that as a failure. It is not one, and saying "the
    // document could not be laid out" to someone who just cancelled is a lie
    // about their own action.
    if (signal.aborted) return;

    // A layout of the document you were importing is not a layout of the one
    // you are importing now: extraction of a second file can finish while this
    // is still in the air.
    if (useUiStore.getState().documentImportSource !== source) return;

    if (!result.ok) {
      setReformat(false);
      setError(
        result.code === 'not_supported'
          ? t('ai.notConfiguredHint')
          : t('import.formatFailed'),
      );
      return;
    }

    // Every edit rejected means the model rewrote the document instead of
    // laying it out. Saying so is the honest answer; quietly showing the
    // original back with the toggle on would claim work that did not happen.
    if (!result.value.applied && result.value.rejected) {
      setReformat(false);
      setError(t('import.formatRejected'));
      return;
    }

    setFormatted(result.value.markdown);
    setFormatNote(
      result.value.applied
        ? t('import.formatApplied', { count: result.value.applied })
        : t('import.formatUnchanged'),
    );
  }

  async function create() {
    if (!source || !document) return;
    setCreating(true);
    setError('');
    setWarning('');
    const result = await createImportedNoteCommand(
      document,
      source,
      keepOriginal,
      reformat ? formatted : null,
    );
    setCreating(false);
    if (!result.ok) {
      setError(t('import.createFailed'));
      return;
    }
    if (keepOriginal && !result.value.attachmentKept) {
      setCompleted(true);
      setWarning(t('import.attachmentWarning'));
      return;
    }
    setSource(null);
  }

  const preview = reformat && formatted !== null ? formatted : (document?.markdown ?? '');

  return (
    <Dialog
      open={source !== null}
      onClose={close}
      title={t('import.title')}
      description={t('import.description')}
      size="lg"
      headerAction={<AiDialogStatus feature="importFormat" onLeave={close} />}
      footer={
        <>
          <GlassButton size="sm" disabled={creating} onClick={close}>
            {completed ? t('common.close') : t('common.cancel')}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="accent"
            disabled={!document || extracting || creating || completed || formatting}
            onClick={() => void create()}
          >
            {creating ? t('import.creating') : t('import.createNote')}
          </GlassButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] px-3 py-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--nb-control-surface)] text-[var(--nb-text-3)]">
            <FileText size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-[var(--nb-text)]">
              {source?.kind === 'attachment' ? source.attachment.name : source?.name}
            </p>
            <p className="text-[11px] text-[var(--nb-text-3)]">
              {document ? formatLabel(document.source.format) : t('import.reading')}
            </p>
          </div>
          <span className="flex items-center gap-1 text-[10px] text-[var(--nb-text-3)]">
            <LockKeyhole size={11} />
            {t('import.localOnly')}
          </span>
        </div>

        {extracting && <FieldNote>{t('import.extracting')}</FieldNote>}
        {error && <FieldNote tone="danger">{error}</FieldNote>}
        {warning && <FieldNote tone="danger">{warning}</FieldNote>}

        {document && (
          <>
            <FieldRow label={t('import.keepOriginal')} align="end">
              <FieldToggle
                label={t('import.keepOriginal')}
                checked={keepOriginal}
                onChange={setKeepOriginal}
              />
            </FieldRow>
            <FieldRow
              label={t('import.reformat')}
              hint={
                availability.available
                  ? t('import.reformatHint')
                  : t('ai.notConfiguredHint')
              }
              align="end"
            >
              <FieldToggle
                label={t('import.reformat')}
                checked={reformat}
                disabled={!availability.available || formatting || creating}
                onChange={(next) => void toggleReformat(next)}
              />
            </FieldRow>
            {formatting && (
              <FieldNote>
                {t('import.formatting')}{' '}
                {/* The toggle itself is disabled while the pass runs, so this
                    is the way back out — and it takes the toggle with it,
                    rather than leaving it on with nothing behind it. */}
                <button
                  type="button"
                  aria-label={t('import.formatCancel')}
                  className="underline underline-offset-2"
                  onClick={() => void toggleReformat(false)}
                >
                  {t('ai.cancel')}
                </button>
              </FieldNote>
            )}
            {reformat && !formatting && formatNote && <FieldNote>{formatNote}</FieldNote>}
            <section>
              <h3 className="mb-2 text-[12px] font-semibold text-[var(--nb-text-2)]">
                {t('import.preview')}
              </h3>
              <div className="max-h-[360px] overflow-auto rounded-lg border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-4 py-3">
                <AiRichText markdown={preview} />
              </div>
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
