/**
 * A transcription in the status bar (plan §10.3): how far it has got while it
 * runs, and that it finished — or failed — once it has, from every view.
 * Clicking it goes back to the lecture, whose player carries the details.
 */
import { AudioLines, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTranscriptionStore } from '@/lib/state/transcriptionStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';

export function TranscriptionStatus() {
  const { t } = useTranslation();
  const { status, input, noteTitle, stage, done, total } = useTranscriptionStore();
  if (status === 'idle' || !input) return null;

  const title = noteTitle || t('noteList.untitled');
  const percent =
    stage === 'transcribing' && total ? Math.round((done / total) * 100) : 0;
  const label =
    status === 'running'
      ? t('transcription.statusBar', { title, percent })
      : status === 'done'
        ? t('transcription.statusBarDone', { title })
        : t('transcription.statusBarFailed', { title });

  return (
    <button
      type="button"
      className={cn(
        'flex min-w-0 items-center gap-1.5 truncate hover:text-nb-text',
        status === 'failed' && 'text-[var(--nb-danger)]',
      )}
      onClick={() => {
        useUiStore.getState().selectNote(input.noteId);
        void useEditorStore.getState().openNote(input.noteId);
      }}
    >
      {status === 'running' ? (
        <Loader2
          size={11}
          className="shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
      ) : (
        <AudioLines size={11} className="shrink-0" aria-hidden />
      )}
      <span className="truncate tabular-nums">{label}</span>
    </button>
  );
}
