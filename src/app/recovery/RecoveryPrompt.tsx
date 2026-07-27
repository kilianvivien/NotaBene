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
 */
import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton } from '@/components/glass';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { discardJournalCommand, recoverJournalCommand } from '@/lib/commands';

export function RecoveryPrompt() {
  const { t, i18n } = useTranslation();
  const pending = useLibraryStore((state) => state.pendingRecoveries);
  const refreshPending = useLibraryStore((state) => state.refreshPendingRecoveries);
  const selectNote = useUiStore((state) => state.selectNote);
  const openNote = useEditorStore((state) => state.openNote);

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
      open={pending.length > 0}
      // Dismissing without answering keeps the rows, so the offer simply comes
      // back next launch rather than the work being thrown away by an
      // accidental Escape.
      onClose={() => void refreshPending()}
      title={t('recovery.title')}
      description={t('recovery.body')}
      size="md"
    >
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
