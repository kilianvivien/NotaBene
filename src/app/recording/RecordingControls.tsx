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
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './recording.css';
import { GlassIconButton } from '@/components/glass';
import { recorder } from '@/lib/adapters';
import { runAppCommand } from '@/lib/commands';
import { formatOffset } from '@/lib/recording/anchors';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { useRecordingStore } from '@/lib/state/recordingStore';

/** Elapsed recording time, ticking once a second while there is one. */
function useRecordingElapsed(): string {
  const startedAt = useRecordingStore((state) => state.startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? '' : formatOffset(now - startedAt);
}

function LevelMeter() {
  const level = useRecordingStore((state) => state.level);
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
  const hasNote = useEditorStore((state) => state.note !== null);
  const readOnly = useLibraryAccessStore((state) => state.status?.readOnly === true);
  const elapsed = useRecordingElapsed();

  // The browser shell cannot record; a button that can only fail is noise.
  if (!recorder.supported()) return null;

  if (status === 'recording' || status === 'stopping') {
    const label = t('recording.stopIn', { title: noteTitle || t('noteList.untitled') });
    return (
      <button
        type="button"
        className="nb-recording-pill"
        aria-label={label}
        title={label}
        disabled={status === 'stopping'}
        onClick={() => void runAppCommand('recording.toggle')}
      >
        <span className="nb-recording-dot" aria-hidden />
        <span className="tabular-nums">{elapsed}</span>
        <LevelMeter />
        <Square size={11} aria-hidden className="fill-current" />
      </button>
    );
  }

  return (
    <GlassIconButton
      label={t('menu.recordLecture')}
      disabled={!hasNote || readOnly || status === 'starting'}
      onClick={() => void runAppCommand('recording.toggle')}
    >
      <Mic size={16} />
    </GlassIconButton>
  );
}

export function RecordingStatus() {
  const { t } = useTranslation();
  const status = useRecordingStore((state) => state.status);
  const noteId = useRecordingStore((state) => state.noteId);
  const noteTitle = useRecordingStore((state) => state.noteTitle);
  const openNoteId = useEditorStore((state) => state.note?.id ?? null);
  const elapsed = useRecordingElapsed();
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
