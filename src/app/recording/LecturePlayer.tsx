/**
 * The lecture player, docked at the foot of a note that has audio (plan §10.0
 * item 5).
 *
 * One row, pinned while the note scrolls: play, back and forward ten seconds,
 * where it is, and — for a note recorded more than once — which recording.
 * Every audio attachment counts, not only recordings made here: a lecture the
 * student recorded on their phone and dropped in is exactly as worth
 * scrubbing, it simply has no anchors.
 *
 * Removing a recording removes the attachment and nothing else. The note keeps
 * its words and its anchors, which fall silent without audio to point at.
 */
import { Pause, Play, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './recording.css';
import { GlassIconButton, GlassSelect } from '@/components/glass';
import { dialog, library } from '@/lib/adapters';
import { attachmentPreviewKind } from '@/lib/attachments/previewSupport';
import { deleteAttachmentCommand } from '@/lib/commands';
import { formatOffset } from '@/lib/recording/anchors';
import { useAttachmentStore } from '@/lib/state/attachmentStore';
import { SKIP_MS, useLecturePlaybackStore } from '@/lib/state/lecturePlaybackStore';
import { useRecordingStore } from '@/lib/state/recordingStore';

export function LecturePlayer({
  noteId,
  readOnly,
}: {
  noteId: string;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const revision = useAttachmentStore((state) => state.revision);
  const playback = useLecturePlaybackStore();
  // The recording being made in this note is not playable until it is kept.
  const recordingHere = useRecordingStore(
    (state) => state.status !== 'idle' && state.noteId === noteId,
  );

  useEffect(() => {
    let cancelled = false;
    void library
      .listAttachments(noteId)
      .then((attachments) => {
        if (cancelled) return;
        const audio = attachments
          .filter((attachment) => attachmentPreviewKind(attachment.name, '') === 'audio')
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        useLecturePlaybackStore.getState().setRecordings(noteId, audio);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [noteId, revision]);

  // Leaving the note stops its lecture; a note you are not looking at should
  // not be talking.
  useEffect(() => () => useLecturePlaybackStore.getState().reset(), [noteId]);

  if (playback.noteId !== noteId || !playback.recordings.length) {
    return recordingHere ? <RecordingHint /> : null;
  }

  const current = playback.recordings.find(
    (recording) => recording.id === playback.currentId,
  );
  const position = formatOffset(playback.positionMs);
  const duration =
    playback.durationMs === null ? null : formatOffset(playback.durationMs);

  async function remove() {
    if (!current) return;
    const confirmed = await dialog.confirm(
      t('recording.removeConfirm', { name: current.name }),
      { title: t('recording.removeTitle'), danger: true },
    );
    if (!confirmed) return;
    await deleteAttachmentCommand(current.id);
  }

  return (
    <div className="nb-lecture-player" role="region" aria-label={t('recording.player')}>
      <GlassIconButton
        label={playback.playing ? t('recording.pause') : t('recording.play')}
        onClick={() => void playback.toggle()}
        disabled={playback.loading}
      >
        {playback.playing ? <Pause size={15} /> : <Play size={15} />}
      </GlassIconButton>
      <GlassIconButton
        label={t('recording.back', { seconds: SKIP_MS / 1000 })}
        onClick={() => void playback.skip(-SKIP_MS)}
      >
        <RotateCcw size={14} />
      </GlassIconButton>
      <GlassIconButton
        label={t('recording.forward', { seconds: SKIP_MS / 1000 })}
        onClick={() => void playback.skip(SKIP_MS)}
      >
        <RotateCw size={14} />
      </GlassIconButton>

      <span className="nb-lecture-time" aria-live="off">
        {playback.loading
          ? t('recording.loading')
          : duration
            ? `${position} / ${duration}`
            : position}
      </span>

      <input
        type="range"
        className="nb-lecture-scrubber"
        min={0}
        max={playback.durationMs ?? Math.max(playback.positionMs, 1)}
        step={1000}
        value={playback.positionMs}
        disabled={playback.durationMs === null}
        aria-label={t('recording.position')}
        aria-valuetext={duration ? `${position} / ${duration}` : position}
        onChange={(event) => void playback.seek(Number(event.target.value))}
      />

      {playback.recordings.length > 1 ? (
        <GlassSelect
          label={t('recording.choose')}
          variant="plain"
          size="sm"
          className="max-w-[14rem] shrink"
          value={playback.currentId ?? ''}
          onChange={(event) => playback.select(event.target.value)}
        >
          {playback.recordings.map((recording) => (
            <option key={recording.id} value={recording.id}>
              {recording.name}
            </option>
          ))}
        </GlassSelect>
      ) : (
        <span className="nb-lecture-name" title={current?.name}>
          {current?.name}
        </span>
      )}

      {playback.error && (
        <span role="status" className="text-[11px] text-[var(--nb-danger)]">
          {t(`recording.playError.${playback.error}`)}
        </span>
      )}

      {!readOnly && (
        <GlassIconButton label={t('recording.remove')} onClick={() => void remove()}>
          <Trash2 size={14} />
        </GlassIconButton>
      )}
    </div>
  );
}

/** Before the first recording is kept there is nothing to play, but a student
 * who just pressed Record deserves to see where their anchors will go. */
function RecordingHint() {
  const { t } = useTranslation();
  return (
    <div className="nb-lecture-player nb-lecture-player-hint" role="status">
      <span className="nb-recording-dot" aria-hidden />
      <span>{t('recording.anchorsHint')}</span>
    </div>
  );
}
