/**
 * Crash recovery, offered at launch.
 *
 * A journal row that is newer than its note means the app stopped between a
 * keystroke and the save that would have kept it. This asks about each one
 * before the user starts typing over it — which is the only moment the choice
 * is still theirs to make.
 *
 * Both answers are safe. Recovering writes forward through the command layer,
 * so the saved version lands in history first; discarding drops only the
 * unsaved tail. There is no third option that loses anything.
 *
 * An interrupted lecture recording is offered here too (plan §10.0 item 3):
 * the audio was written slice by slice, so everything up to the last few
 * seconds is on disk. Keeping it attaches it to the note it was started in;
 * the microphone is never switched back on.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton } from '@/components/glass';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import {
  discardInterruptedRecordingCommand,
  discardJournalCommand,
  listInterruptedRecordingsCommand,
  recoverJournalCommand,
  recoverRecordingCommand,
  type InterruptedRecording,
} from '@/lib/commands';
import { formatBytes } from '@/lib/utils/formatBytes';

export function RecoveryPrompt() {
  const { t, i18n } = useTranslation();
  const pending = useLibraryStore((state) => state.pendingRecoveries);
  const refreshPending = useLibraryStore((state) => state.refreshPendingRecoveries);
  const selectNote = useUiStore((state) => state.selectNote);
  const openNote = useEditorStore((state) => state.openNote);
  const [recordings, setRecordings] = useState<InterruptedRecording[]>([]);
  const [recordingError, setRecordingError] = useState('');

  // Asked once, at launch — the same moment the journal is read. A recording
  // started later in this session is running, not interrupted, and Rust
  // leaves it out.
  useEffect(() => {
    void listInterruptedRecordingsCommand().then(setRecordings);
  }, []);

  async function onKeepRecording(recording: InterruptedRecording) {
    const result = await recoverRecordingCommand(recording);
    if (!result.ok) {
      setRecordingError(result.message);
      return;
    }
    setRecordingError('');
    setRecordings((current) => current.filter((entry) => entry.id !== recording.id));
    selectNote(recording.noteId);
    await openNote(recording.noteId);
  }

  async function onDiscardRecording(recording: InterruptedRecording) {
    const result = await discardInterruptedRecordingCommand(recording.id);
    if (!result.ok) {
      setRecordingError(result.message);
      return;
    }
    setRecordings((current) => current.filter((entry) => entry.id !== recording.id));
  }

  async function onRecover(noteId: string) {
    const result = await recoverJournalCommand(noteId);
    await refreshPending();
    if (!result.ok) return;
    // Land the user in the recovered note: they were mid-sentence in it when
    // the app died, and that is where they want to be.
    selectNote(noteId);
    await openNote(noteId);
  }

  async function onDiscard(noteId: string) {
    await discardJournalCommand(noteId);
    await refreshPending();
  }

  return (
    <Dialog
      // Driven by the list rather than unmounted outright, so answering the
      // last one lets the panel leave the way it arrived.
      open={pending.length > 0 || recordings.length > 0}
      // Dismissing without answering keeps the rows, so the offer simply comes
      // back next launch rather than the work being thrown away by an
      // accidental Escape.
      onClose={() => {
        setRecordings([]);
        void refreshPending();
      }}
      title={pending.length ? t('recovery.title') : t('recovery.recordingTitle')}
      description={pending.length ? t('recovery.body') : t('recovery.recordingBody')}
      size="md"
    >
      {recordings.length > 0 && (
        <>
          {pending.length > 0 && (
            <p className="mb-2 text-[12px] text-nb-text-2">
              {t('recovery.recordingBody')}
            </p>
          )}
          <ul className="mb-3 flex flex-col gap-2">
            {recordings.map((recording) => (
              <li
                key={recording.id}
                className="flex flex-wrap items-center gap-2 rounded-nb-sm bg-[var(--nb-hover)] p-2.5"
              >
                <div className="min-w-0 flex-1 basis-[55%]">
                  <p className="truncate text-[13px] font-medium">
                    {t('recovery.recordingRow', {
                      time: new Date(recording.startedAt).toLocaleString(i18n.language, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }),
                    })}
                  </p>
                  <p className="text-[11px] text-nb-text-3">
                    {formatBytes(recording.bytes, i18n.language === 'fr' ? 'fr' : 'en')}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 gap-2">
                  <GlassButton
                    size="sm"
                    onClick={() => void onDiscardRecording(recording)}
                  >
                    {t('recovery.discard')}
                  </GlassButton>
                  <GlassButton
                    size="sm"
                    variant="accent"
                    data-autofocus={pending.length ? undefined : true}
                    onClick={() => void onKeepRecording(recording)}
                  >
                    {t('recovery.keepRecording')}
                  </GlassButton>
                </div>
              </li>
            ))}
          </ul>
          {recordingError && (
            <p role="alert" className="mb-3 text-[12px] text-[var(--nb-danger)]">
              {recordingError}
            </p>
          )}
        </>
      )}
      <ul className="flex flex-col gap-2">
        {pending.map((entry) => (
          <li
            key={entry.noteId}
            className="flex flex-wrap items-center gap-2 rounded-nb-sm bg-[var(--nb-hover)] p-2.5"
          >
            <div className="min-w-0 flex-1 basis-[55%]">
              <p className="truncate text-[13px] font-medium">
                {entry.title || entry.noteTitle || t('noteList.untitled')}
              </p>
              <p className="text-[11px] text-nb-text-3">
                {t('recovery.unsavedSince', {
                  time: new Date(entry.writtenAt).toLocaleTimeString(i18n.language),
                  saved: new Date(entry.noteUpdatedAt).toLocaleTimeString(i18n.language),
                })}
              </p>
            </div>
            <div className="ml-auto flex shrink-0 gap-2">
              <GlassButton size="sm" onClick={() => void onDiscard(entry.noteId)}>
                {t('recovery.discard')}
              </GlassButton>
              <GlassButton
                size="sm"
                variant="accent"
                // Claim the opening focus away from Discard, which the markup
                // order would otherwise hand it to. Both answers are safe to
                // *choose*, but only one is safe to hit by accident: the tail
                // Discard drops is the one copy of it that exists, and this
                // dialog greets someone whose app just died.
                data-autofocus
                onClick={() => void onRecover(entry.noteId)}
              >
                {t('recovery.restore')}
              </GlassButton>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
