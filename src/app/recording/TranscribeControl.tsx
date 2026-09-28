/**
 * Transcription, inside the lecture player (plan §10.3).
 *
 * Deliberately not a dialog. The player is where a recording already lives,
 * so transcribing it is one more button there: a small glass popover asks
 * the two things worth asking — the language and where the text goes — and
 * says in one line where the audio is heard. Once started, the job reports
 * in the player row itself (and in the status bar from any other view), and
 * the student keeps reading or typing underneath. This departs from the AI
 * dialogs' `ChoiceGroup` cards on purpose: the owner asked for transcription
 * to stay out of the way.
 *
 * The job belongs to `transcriptionStore`, so leaving the note does not stop
 * it and coming back shows where it is.
 */
import { AudioLines, CircleAlert, Cloud, FileText, Lock, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, GlassIconButton, GlassPopupButton } from '@/components/glass';
import { asr, asrRegistry } from '@/lib/adapters';
import type { TranscriptionDestination } from '@/lib/commands';
import { formatOffset } from '@/lib/recording/anchors';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLecturePlaybackStore } from '@/lib/state/lecturePlaybackStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useTranscriptionStore } from '@/lib/state/transcriptionStore';
import { useUiStore } from '@/lib/state/uiStore';
import { transcriptionErrorMessage } from './transcriptionErrorMessage';

type Language = 'auto' | 'fr' | 'en';

export function TranscribeControl({
  noteId,
  noteTitle,
  attachmentId,
}: {
  noteId: string;
  noteTitle: string;
  attachmentId: string;
}) {
  const { t } = useTranslation();
  const job = useTranscriptionStore();
  const target = useUiStore((state) => state.transcribeTarget);
  const setTarget = useUiStore((state) => state.setTranscribeTarget);
  const settings = useSettingsStore((state) => state.settings.recording.transcription);
  const durationMs = useLecturePlaybackStore((state) =>
    state.loadedId === attachmentId ? state.durationMs : null,
  );
  const [language, setLanguage] = useState<Language>(settings.language);
  const [destination, setDestination] = useState<TranscriptionDestination>('append');
  const popover = useRef<HTMLDivElement>(null);

  // The command table and the status bar open the popover by naming the
  // recording; the player is where it appears.
  const open = target?.noteId === noteId && target.attachmentId === attachmentId;
  useEffect(() => {
    if (open) setLanguage(settings.language);
  }, [open, settings.language]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!popover.current?.contains(event.target as Node)) setTarget(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTarget(null);
    };
    // Next tick, so the click that opened it does not close it.
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', onPointer);
    });
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, setTarget]);

  if (!asr.supported()) return null;

  const capabilities = asrRegistry.get(settings.engineId).capabilities();
  const mine = job.input?.noteId === noteId && job.input.attachmentId === attachmentId;
  const running = job.status === 'running';
  const percent =
    job.stage === 'transcribing' && job.total
      ? Math.round((job.done / job.total) * 100)
      : 0;

  function start() {
    setTarget(null);
    void job.start(
      {
        noteId,
        attachmentId,
        engineId: settings.engineId,
        language: capabilities.languageHint ? language : 'auto',
        destination,
        useCourseVocabulary: settings.useCourseVocabulary,
      },
      noteTitle,
    );
  }

  async function openTranscript() {
    const transcriptId = job.outcome?.noteId;
    job.dismiss();
    if (!transcriptId) return;
    if (transcriptId === noteId) {
      // Appended here: the transcript is the last "Transcript" heading.
      const headings = document.querySelectorAll<HTMLElement>('.nb-prosemirror h2');
      headings[headings.length - 1]?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
      return;
    }
    useUiStore.getState().selectNote(transcriptId);
    await useEditorStore.getState().openNote(transcriptId);
  }

  // -- The job, reported in the row ----------------------------------------

  if (mine && running) {
    // The row carries the bar and a number; the words are in the status bar
    // and in the accessible name, where there is room for them.
    const label =
      job.stage === 'transcribing'
        ? t('transcription.inline', { percent })
        : t(`transcription.stage.${job.stage}`);
    return (
      <span
        className="nb-transcribe-status"
        role="status"
        aria-label={label}
        title={label}
      >
        <span className="nb-transcribe-bar" aria-hidden>
          <span style={{ width: `${Math.max(percent, 4)}%` }} />
        </span>
        <span className="tabular-nums text-nb-text-3" aria-hidden>
          {job.stage === 'transcribing' ? `${percent}%` : '…'}
        </span>
        <GlassIconButton label={t('transcription.stop')} onClick={() => job.cancel()}>
          <Square size={11} />
        </GlassIconButton>
      </span>
    );
  }

  if (mine && job.status === 'done' && job.outcome) {
    // One link: to the passages worth a second listen when there are any,
    // to the transcript otherwise.
    const passages = job.outcome.passages;
    const label =
      passages > 0
        ? t('transcription.reviewShort', { count: passages })
        : job.outcome.noteId === noteId
          ? t('transcription.doneHere')
          : t('transcription.open');
    return (
      <span className="nb-transcribe-status" role="status">
        <button
          type="button"
          className="nb-transcribe-link"
          title={t('transcription.statusBarDone', { title: noteTitle })}
          onClick={() => void openTranscript()}
        >
          <FileText size={12} aria-hidden />
          {label}
        </button>
        <GlassIconButton label={t('transcription.dismiss')} onClick={() => job.dismiss()}>
          <X size={11} />
        </GlassIconButton>
      </span>
    );
  }

  // A failure keeps the row short; the reason is in the popover Retry opens,
  // where there is room to read it.
  const failure =
    mine && job.status === 'failed' && job.failure
      ? transcriptionErrorMessage(job.failure, t)
      : null;
  if (failure && !open) {
    return (
      <span
        className="nb-transcribe-status text-[var(--nb-danger)]"
        role="alert"
        title={failure}
      >
        <button
          type="button"
          className="nb-transcribe-link nb-danger"
          onClick={() => setTarget({ noteId, attachmentId })}
        >
          <CircleAlert size={12} aria-hidden />
          {t('transcription.failedShort')}
        </button>
        <GlassIconButton label={t('transcription.dismiss')} onClick={() => job.dismiss()}>
          <X size={11} />
        </GlassIconButton>
      </span>
    );
  }

  // -- Idle: one button, and the popover it opens --------------------------

  const where = durationMs
    ? t('transcription.whereHosted', { duration: formatOffset(durationMs) })
    : t('transcription.whereHostedShort');
  const WhereIcon = capabilities.local ? Lock : Cloud;

  return (
    <span className="relative flex shrink-0">
      <GlassIconButton
        label={
          running
            ? t('transcription.busyElsewhere', { title: job.noteTitle })
            : t('recording.transcribe')
        }
        disabled={running}
        onClick={() => setTarget(open ? null : { noteId, attachmentId })}
      >
        <AudioLines size={14} />
      </GlassIconButton>
      {open && (
        <div
          ref={popover}
          className="nb-transcribe-popover"
          role="dialog"
          aria-labelledby="nb-transcribe-title"
        >
          <header className="nb-transcribe-header">
            <span id="nb-transcribe-title">{t('transcription.popoverTitle')}</span>
            <span
              className={
                capabilities.local
                  ? 'nb-transcribe-badge'
                  : 'nb-transcribe-badge nb-hosted'
              }
            >
              <WhereIcon size={10} aria-hidden />
              {capabilities.local
                ? t('transcription.badgeLocal')
                : t('transcription.badgeHosted')}
            </span>
          </header>

          <div className="nb-transcribe-rows">
            <span className="nb-transcribe-label">
              {t('transcription.labelLanguage')}
            </span>
            {capabilities.languageHint ? (
              <GlassPopupButton<Language>
                label={t('transcription.languageQuestion')}
                value={language}
                onChange={setLanguage}
                options={[
                  { value: 'auto', label: t('transcription.languageAuto') },
                  { value: 'fr', label: t('transcription.languageFr') },
                  { value: 'en', label: t('transcription.languageEn') },
                ]}
              />
            ) : (
              <span className="nb-transcribe-fixed">
                {t('transcription.languageHosted')}
              </span>
            )}
            <span className="nb-transcribe-label">{t('transcription.labelInto')}</span>
            <GlassPopupButton<TranscriptionDestination>
              label={t('transcription.destinationQuestion')}
              value={destination}
              onChange={setDestination}
              options={[
                { value: 'new-note', label: t('transcription.destinationNew') },
                { value: 'append', label: t('transcription.destinationAppend') },
              ]}
            />
          </div>

          <footer className="nb-transcribe-footer">
            {/* A hosted engine is named, with who pays, every time. On this
                Mac the badge above already says all there is to say. */}
            {failure && <p className="nb-transcribe-where nb-danger">{failure}</p>}
            {!capabilities.local && <p className="nb-transcribe-where">{where}</p>}
            <GlassButton
              size="sm"
              variant="accent"
              className="w-full justify-center"
              onClick={start}
            >
              {failure ? t('transcription.retry') : t('transcription.start')}
            </GlassButton>
          </footer>
        </div>
      )}
    </span>
  );
}
