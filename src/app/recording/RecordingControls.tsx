/**
 * The recording's presence in the chrome (plan §10.0 item 6).
 *
 * The title bar holds the control: a microphone while idle, and while
 * recording a pill with the elapsed time and a level meter that is also the
 * Stop button. The status bar repeats the fact from every view, and names the
 * note when the student has wandered away from it — anchors only land in the
 * note the recording started in, and that should never be a surprise.
 *
 * The macOS recording indicator in the menu bar is the real guarantee; this is
 * the app agreeing with it.
 */
import { Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './recording.css';
import { GlassIconButton } from '@/components/glass';
import { recorder } from '@/lib/adapters';
import { runAppCommand } from '@/lib/commands';
import { formatOffset } from '@/lib/recording/anchors';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { useRecordingStore } from '@/lib/state/recordingStore';
import { useDictationStore } from '@/lib/state/dictationStore';

/** Elapsed recording time, ticking once a second while there is one. */
function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? '' : formatOffset(now - startedAt);
}

function LevelMeter({ dictating = false }: { dictating?: boolean }) {
  const recordedLevel = useRecordingStore((state) => state.level);
  const dictatedLevel = useDictationStore((state) => state.level);
  const level = dictating ? dictatedLevel : recordedLevel;
  // Five bars, lit from the left. Coarse on purpose: this says "it can hear
  // the room", not "here is a VU meter to watch instead of the lecturer".
  const lit = Math.round(level * 5);
  return (
    <span className="nb-level-meter" aria-hidden>
      {[0, 1, 2, 3, 4].map((bar) => (
        <span key={bar} data-lit={bar < lit || undefined} />
      ))}
    </span>
  );
}

export function RecordButton() {
  const { t } = useTranslation();
  const status = useRecordingStore((state) => state.status);
  const noteTitle = useRecordingStore((state) => state.noteTitle);
  const countdown = useRecordingStore((state) => state.countdown);
  const openNoteId = useEditorStore((state) => state.note?.id ?? null);
  const hasNote = openNoteId !== null;
  const readOnly = useLibraryAccessStore((state) => state.status?.readOnly === true);
  const recordedAt = useRecordingStore((state) => state.startedAt);
  const dictationStatus = useDictationStore((state) => state.status);
  const dictatedAt = useDictationStore((state) => state.startedAt);
  const elapsed = useElapsed(dictationStatus !== 'idle' ? dictatedAt : recordedAt);
  const [holding, setHolding] = useState<number | null>(null);
  const [hint, setHint] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const suppressClick = useRef(false);
  const enabled = hasNote && !readOnly;
  const clearHold = () => {
    if (timer.current) clearTimeout(timer.current);
    if (ticker.current) clearInterval(ticker.current);
    timer.current = null;
    ticker.current = null;
    setHolding(null);
  };
  const beginHold = () => {
    if (!enabled || status !== 'idle' || dictationStatus !== 'idle' || timer.current)
      return;
    suppressClick.current = false;
    setHolding(5);
    const started = Date.now();
    ticker.current = setInterval(
      () => setHolding(Math.max(1, Math.ceil((5000 - (Date.now() - started)) / 1000))),
      100,
    );
    timer.current = setTimeout(() => {
      suppressClick.current = true;
      clearHold();
      void runAppCommand('recording.dictation');
    }, 5000);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (ticker.current) clearInterval(ticker.current);
    },
    [],
  );
  useEffect(() => {
    if (timer.current || ticker.current) suppressClick.current = true;
    if (timer.current) clearTimeout(timer.current);
    if (ticker.current) clearInterval(ticker.current);
    timer.current = null;
    ticker.current = null;
    setHolding(null);
  }, [enabled, status, dictationStatus, openNoteId]);
  useEffect(() => {
    const cancel = () => {
      if (!timer.current) return;
      suppressClick.current = true;
      clearTimeout(timer.current);
      if (ticker.current) clearInterval(ticker.current);
      timer.current = null;
      ticker.current = null;
      setHolding(null);
    };
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);
  const activate = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    clearHold();
    void runAppCommand(
      dictationStatus !== 'idle' ? 'recording.dictation' : 'recording.toggle',
    );
  };

  // The browser shell cannot record; a button that can only fail is noise.
  if (!recorder.supported()) return null;

  const dictating = dictationStatus !== 'idle';
  const active = dictating || status !== 'idle';
  const label = dictating
    ? t('dictation.stop')
    : active
      ? t('recording.stopIn', { title: noteTitle || t('noteList.untitled') })
      : t('dictation.micHint');
  return (
    <span className="relative inline-flex">
      <GlassIconButton
        label={label}
        className={active ? 'nb-recording-pill w-auto' : ''}
        active={dictating || undefined}
        disabled={
          dictationStatus === 'stopping' ||
          status === 'starting' ||
          status === 'stopping' ||
          (!active && !enabled)
        }
        onClick={activate}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          suppressClick.current = false;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          beginHold();
        }}
        onPointerUp={clearHold}
        onPointerCancel={() => {
          suppressClick.current = true;
          clearHold();
        }}
        onLostPointerCapture={clearHold}
        onMouseEnter={() => setHint(true)}
        onMouseLeave={() => {
          setHint(false);
          if (timer.current) {
            suppressClick.current = true;
            clearHold();
          }
        }}
        onFocus={() => setHint(true)}
        onBlur={() => {
          setHint(false);
          if (timer.current) {
            suppressClick.current = true;
            clearHold();
          }
        }}
      >
        <Mic size={active ? 14 : 16} aria-hidden />
        {dictating ? (
          <>
            <span className="nb-recording-dot" aria-hidden />
            <span>{t(`dictation.${dictationStatus}`)}</span>
            {elapsed && <span className="tabular-nums">{elapsed}</span>}
            <LevelMeter dictating />
            <Square size={11} aria-hidden className="fill-current" />
          </>
        ) : status === 'starting' ? (
          <span role="status" aria-live="polite">
            {countdown !== null && countdown > 0
              ? t('recording.countdown', { seconds: countdown })
              : t('recording.preparing')}
          </span>
        ) : active ? (
          <>
            <span className="nb-recording-dot" aria-hidden />
            <span className="tabular-nums">{elapsed}</span>
            <LevelMeter />
            <Square size={11} aria-hidden className="fill-current" />
          </>
        ) : null}
      </GlassIconButton>
      {!active && (hint || holding !== null) && (
        <span className="nb-dictation-hint" role="status" aria-live="polite">
          <strong>
            {holding !== null
              ? t('dictation.holdCountdown', { seconds: holding })
              : t('dictation.micHint')}
          </strong>
          <span>{t('dictation.privacy')}</span>
          {holding !== null && (
            <span className="nb-dictation-hold-track" aria-hidden>
              <span style={{ width: `${(5 - holding) * 20}%` }} />
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function RecordingStatus() {
  const { t } = useTranslation();
  const status = useRecordingStore((state) => state.status);
  const noteId = useRecordingStore((state) => state.noteId);
  const noteTitle = useRecordingStore((state) => state.noteTitle);
  const openNoteId = useEditorStore((state) => state.note?.id ?? null);
  const startedAt = useRecordingStore((state) => state.startedAt);
  const dictationStatus = useDictationStore((state) => state.status);
  const elapsed = useElapsed(startedAt);
  if (dictationStatus !== 'idle')
    return (
      <span className="text-[var(--nb-accent)]" role="status">
        {t(`dictation.${dictationStatus}`)} · Voxtral 3
      </span>
    );
  if (status !== 'recording' && status !== 'stopping') return null;

  const elsewhere = openNoteId !== noteId;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[var(--nb-danger)]">
      <span className="nb-recording-dot" aria-hidden />
      <span className="tabular-nums">
        {status === 'stopping'
          ? t('recording.saving')
          : t('recording.status', { time: elapsed })}
      </span>
      {elsewhere && (
        <span className="truncate text-nb-text-3">
          {t('recording.anchorsElsewhere', {
            title: noteTitle || t('noteList.untitled'),
          })}
        </span>
      )}
    </span>
  );
}
