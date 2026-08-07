import { FileText, LockKeyhole } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AiRichText } from '@/app/ai/AiRichText';
import {
  Dialog,
  FieldNote,
  FieldRow,
  FieldToggle,
  GlassButton,
} from '@/components/glass';
import { createImportedNoteCommand, extractDocumentCommand } from '@/lib/commands';
import type { ImportedDocument } from '@/lib/schema';
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
  const [document, setDocument] = useState<ImportedDocument | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [keepOriginal, setKeepOriginal] = useState(true);
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
    setSource(null);
  }

  async function create() {
    if (!source || !document) return;
    setCreating(true);
    setError('');
    setWarning('');
    const result = await createImportedNoteCommand(document, source, keepOriginal);
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

  return (
    <Dialog
      open={source !== null}
      onClose={close}
      title={t('import.title')}
      description={t('import.description')}
      size="lg"
      footer={
        <>
          <GlassButton size="sm" disabled={creating} onClick={close}>
            {completed ? t('common.close') : t('common.cancel')}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="accent"
            disabled={!document || extracting || creating || completed}
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
            <section>
              <h3 className="mb-2 text-[12px] font-semibold text-[var(--nb-text-2)]">
                {t('import.preview')}
              </h3>
              <div className="max-h-[360px] overflow-auto rounded-lg border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-4 py-3">
                <AiRichText markdown={document.markdown} />
              </div>
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
