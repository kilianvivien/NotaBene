import { Archive, FolderOpen, Pin, PinOff, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, type ContextPoint } from '@/components/glass';
import { restoreNoteCommand, trashNoteCommand, updateNoteCommand } from '@/lib/commands';
import type { NoteSummary } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';

export type { ContextPoint };

export function NoteContextMenu({
  note,
  point,
  onClose,
}: {
  note: NoteSummary;
  point: ContextPoint;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const selectNote = useUiStore((state) => state.selectNote);
  const openNote = useEditorStore((state) => state.openNote);

  async function update(patch: { pinned?: boolean; archived?: boolean }) {
    await useEditorStore.getState().flush();
    const result = await updateNoteCommand({ noteId: note.id, ...patch });
    if (!result.ok) return;
    if (patch.archived) {
      if (useEditorStore.getState().note?.id === note.id) {
        await useEditorStore.getState().closeNote();
      }
      useUiStore.getState().selectNote(null);
    } else if (useEditorStore.getState().note?.id === note.id) {
      await useEditorStore.getState().openNote(note.id);
    }
  }

  return (
    <ContextMenu
      point={point}
      onClose={onClose}
      header={note.title || t('noteList.untitled')}
      items={[
        {
          id: 'open',
          label: t('noteActions.open'),
          icon: FolderOpen,
          onSelect: () => {
            selectNote(note.id);
            void openNote(note.id);
          },
        },
        ...(note.trashedAt
          ? [
              {
                id: 'restore',
                label: t('noteActions.restore'),
                icon: RotateCcw,
                onSelect: () => void restoreNoteCommand(note.id),
              },
            ]
          : [
              {
                id: 'pin',
                label: note.pinned ? t('noteActions.unpin') : t('noteActions.pin'),
                icon: note.pinned ? PinOff : Pin,
                onSelect: () => void update({ pinned: !note.pinned }),
              },
              {
                id: 'archive',
                label: note.archived
                  ? t('noteActions.unarchive')
                  : t('noteActions.archive'),
                icon: Archive,
                onSelect: () => void update({ archived: !note.archived }),
              },
              null,
              {
                id: 'trash',
                label: t('noteActions.moveToTrash'),
                icon: Trash2,
                danger: true,
                onSelect: () => void trashNoteCommand(note.id),
              },
            ]),
      ]}
    />
  );
}
