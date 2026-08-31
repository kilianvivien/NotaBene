import { FileText, LockKeyhole, ScanText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  GlassSelect,
} from '@/components/glass';
import {
  createImportedNoteCommand,
  extractDocumentCommand,
  ocrAvailableCommand,
  ocrLanguagesCommand,
  reformatDocumentCommand,
  runOcrCommand,
  type OcrRequirement,
} from '@/lib/commands';
import type { ImportedDocument, ImportWarning } from '@/lib/schema';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useUiStore } from '@/lib/state/uiStore';

function formatLabel(format: string): string {
  if (format === 'markdown') return 'Markdown';
  if (format === 'text') return 'Text';
  return format.toUpperCase();
}

/**
 * Extraction failure code -> what to tell the student.
 *
 * The codes come from `extractDocumentCommand`, which flattens AnyDoc's typed
 * errors. Anything absent falls back to `import.failed`, so an upstream
 * variant we do not know about still says something true.
 */
const EXTRACTION_MESSAGES: Record<string, string> = {
  ocr_required: 'import.ocrRequired',
  unsupported_format: 'import.unsupported',
  attachment_missing: 'import.attachmentMissing',
  encrypted: 'import.encrypted',
  too_large: 'import.tooLarge',
  missing_part: 'import.missingPart',
  malformed: 'import.malformed',
};

/**
 * What the conversion could not carry, said plainly before the note is made.
 *
 * These arrive as codes with counts rather than sentences: Rust cannot build
 * a message that exists in both locales. An unknown code is shown as a
 * generic line rather than skipped, so a version skew never hides a loss.
 */
function ConversionNotes({ warnings }: { warnings: ImportWarning[] }) {
  const { t } = useTranslation();
  if (!warnings.length) return null;
  return (
    <FieldNote>
      <ul className="list-disc space-y-0.5 pl-4">
        {warnings.map((warning) => (
          <li key={warning.code}>
            {t([`import.warning.${warning.code}`, 'import.warning.unknown'], {
              count: warning.count,
            })}
          </li>
        ))}
      </ul>
    </FieldNote>
  );
}

/** A BCP-47 identifier as its own language's name — `Intl` already knows
 *  every one Vision can return, so there is no list to translate. */
function languageLabel(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** `details` crosses the command boundary as `unknown`. */
function isOcrRequirement(details: unknown): details is OcrRequirement {
  return (
    typeof details === 'object' &&
    details !== null &&
    Array.isArray((details as OcrRequirement).pages)
  );
}

export function ImportDocumentDialog() {
  const { t } = useTranslation();
  const source = useUiStore((state) => state.documentImportSource);
  const setSource = useUiStore((state) => state.setDocumentImportSource);
  const availability = useAiAvailability('importFormat');
  // The study pass runs as a rewrite, so it is the rewrite feature's
  // configuration that decides whether to offer it — these can differ, since
  // a model is choosable per feature.
  const studyAvailability = useAiAvailability('rewrite');
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
  /** Turn the imported document into revision notes, once it is a note.
   *  Off by default and reset per document, like the layout pass. */
  const [study, setStudy] = useState(false);
  /** Set only once a note actually exists, so cancelling before that hands
   *  nothing off. */
  const [studyPending, setStudyPending] = useState(false);
  const [formatNote, setFormatNote] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  /** The scanned pages the conversion named, when it named any. Holding the
   * requirement rather than a boolean is what lets the offer say how many
   * pages, and lets the run read only those. */
  const [ocrNeeded, setOcrNeeded] = useState<OcrRequirement | null>(null);
  const [ocrReady, setOcrReady] = useState(false);
  const [ocrLanguages, setOcrLanguages] = useState<string[]>([]);
  const [ocrLanguage, setOcrLanguage] = useState('');
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const ocrRun = useRef<AbortController | null>(null);

  // Whether this build can read a page at all, asked once. The offer is
  // hidden rather than shown-and-failing on a build without Vision.
  useEffect(() => {
    let active = true;
    void ocrAvailableCommand().then((value) => {
      if (!active) return;
      setOcrReady(value);
      if (!value) return;
      void ocrLanguagesCommand().then((result) => {
        if (active && result.ok) setOcrLanguages(result.value);
      });
    });
    return () => {
      active = false;
    };
  }, []);

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
    setStudy(false);
    setStudyPending(false);
    setOcrNeeded(null);
    setOcrProgress(null);
    setOcrLanguage('');
    setExtracting(true);
    void extractDocumentCommand(source).then((result) => {
      if (!active) return;
      setExtracting(false);
      if (result.ok) {
        setDocument(result.value);
        return;
      }
      // A scanned PDF is the one failure with something to offer rather than
      // only something to report. It gets the offer panel and no error: a red
      // line above a button asking to proceed reads as a refusal, not a
      // choice. Whether this build can act on it is answered separately,
      // because that answer can arrive after this one.
      if (result.message === 'ocr_required' && isOcrRequirement(result.details)) {
        setOcrNeeded(result.details);
        return;
      }
      setError(t(EXTRACTION_MESSAGES[result.message] ?? 'import.failed'));
    });
    return () => {
      active = false;
    };
  }, [source, t]);

  /**
   * Leave the dialog, handing off to the study pass if one was asked for.
   *
   * A hand-off rather than a stage in this pipeline: the note already exists
   * and is open by the time this runs, so `RewriteDialog` works on it
   * unchanged — with its per-block gate, and with the plain imported document
   * in version history behind it. Rejecting every block leaves exactly the
   * import.
   */
  function finish(handOff: boolean) {
    if (handOff) {
      const ui = useUiStore.getState();
      ui.setPendingRewriteMode('study');
      ui.setAiRewriteOpen(true);
    }
    setSource(null);
  }

  function close() {
    if (creating) return;
    cancelRun('importFormat');
    ocrRun.current?.abort();
    // Closing after a completed import still owes the hand-off; closing
    // before one has nothing to hand off.
    finish(studyPending);
  }

  /**
   * Read the scanned pages and convert the PDF again with them.
   *
   * Cancelling is simply not starting the next page: nothing has been written
   * at this point, so there is nothing to undo. The dialog goes back to
   * offering the run rather than pretending it never happened.
   */
  async function readScannedPages() {
    if (!source || !ocrNeeded) return;
    const controller = new AbortController();
    ocrRun.current = controller;
    setError('');
    setOcrProgress({ done: 0, total: ocrNeeded.pages.length });

    const result = await runOcrCommand(source, ocrNeeded.pages, {
      signal: controller.signal,
      languages: ocrLanguage ? [ocrLanguage] : [],
      onProgress: setOcrProgress,
    });

    ocrRun.current = null;
    setOcrProgress(null);
    if (controller.signal.aborted) return;
    // Extraction of a second file can finish while this is still in the air.
    if (useUiStore.getState().documentImportSource !== source) return;

    if (!result.ok) {
      setError(t(result.message === 'cancelled' ? 'import.failed' : 'import.ocrFailed'));
      return;
    }
    setOcrNeeded(null);
    setError('');
    setDocument(result.value.document);
    // A page that was read and turned out blank is a fact about the document,
    // not a failure — say it plainly rather than leaving the note quietly
    // shorter than the PDF.
    setWarning(
      result.value.blank
        ? t('import.ocrBlankPages', { count: result.value.blank })
        : '',
    );
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
    setStudyPending(study);
    const lost = result.value.warnings.filter((warning) =>
      warning.code.startsWith('asset'),
    );
    if (keepOriginal && !result.value.attachmentKept) {
      setCompleted(true);
      setWarning(t('import.attachmentWarning'));
      return;
    }
    if (lost.length) {
      setCompleted(true);
      setWarning(
        lost
          .map((warning) =>
            t([`import.warning.${warning.code}`, 'import.warning.unknown'], {
              count: warning.count,
            }),
          )
          .join(' '),
      );
      return;
    }
    // The flag is passed rather than read back: `setStudyPending` above has
    // not reached state by this line, and it is only there for the warning
    // path, where the student closes the dialog on a later render.
    finish(study);
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

        {ocrNeeded && !ocrReady && (
          <FieldNote tone="danger">{t('import.ocrRequired')}</FieldNote>
        )}

        {ocrNeeded && ocrReady && !ocrProgress && (
          <div className="flex flex-col gap-3 rounded-lg border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] px-3 py-3">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--nb-control-surface)] text-[var(--nb-text-3)]">
                <ScanText size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[var(--nb-text)]">
                  {t('import.ocrOffer', {
                    count: ocrNeeded.pages.length,
                    total: ocrNeeded.pageCount,
                  })}
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--nb-text-3)]">
                  {t('import.ocrOfferHint')}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              {/* Offered rather than assumed: a French page read as English
                  comes back as nonsense, and the machine's own language is
                  not evidence about the document's. */}
              <GlassSelect
                label={t('import.ocrLanguage')}
                size="sm"
                value={ocrLanguage}
                onChange={(event) => setOcrLanguage(event.target.value)}
              >
                <option value="">{t('import.ocrLanguageAuto')}</option>
                {ocrLanguages.map((language) => (
                  <option key={language} value={language}>
                    {languageLabel(language)}
                  </option>
                ))}
              </GlassSelect>
              <GlassButton
                size="sm"
                variant="accent"
                onClick={() => void readScannedPages()}
              >
                {t('import.ocrRun')}
              </GlassButton>
            </div>
          </div>
        )}

        {ocrProgress && (
          <FieldNote>
            {t('import.ocrRunning', {
              done: ocrProgress.done,
              total: ocrProgress.total,
            })}{' '}
            <button
              type="button"
              aria-label={t('import.ocrCancel')}
              className="underline underline-offset-2"
              onClick={() => ocrRun.current?.abort()}
            >
              {t('ai.cancel')}
            </button>
          </FieldNote>
        )}

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
            {/* Adjacent to the layout toggle and deliberately worded against
                it: that one promises the wording is untouched, this one
                changes it. The hint is the only thing standing between the
                two, so it says so plainly rather than selling the feature. */}
            <FieldRow
              label={t('import.study')}
              hint={
                studyAvailability.available
                  ? t('import.studyHint')
                  : t('ai.notConfiguredHint')
              }
              align="end"
            >
              <FieldToggle
                label={t('import.study')}
                checked={study}
                disabled={!studyAvailability.available || creating}
                onChange={setStudy}
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
            <ConversionNotes warnings={document.diagnostics.warnings} />
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
