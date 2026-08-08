import {
  Archive,
  Combine,
  FolderOpen,
  Pin,
  PinOff,
  RotateCcw,
  Share,
  Tag,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, type ContextPoint } from '@/components/glass';
import {
  archiveNotesCommand,
  restoreNoteCommand,
  restoreNotesCommand,
  tagNotesCommand,
  trashNoteCommand,
  trashNotesCommand,
  updateNoteCommand,
} from '@/lib/commands';
import { tagLabel } from '@/lib/notes/tagLabel';
import type { NoteSummary } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
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
  const setExportOpen = useUiStore((state) => state.setExportOpen);
  const setMergeOpen = useUiStore((state) => state.setMergeOpen);
  const multiSelection = useUiStore((state) => state.multiSelection);
  const openNote = useEditorStore((state) => state.openNote);
  const tags = useLibraryStore((state) => state.tags);
  const availableTags = tags.filter((tag) => !note.tagIds.includes(tag.id));

  // The row was already checked against the selection before this menu opened
  // (`NoteList` leaves a selection intact when you right-click inside it), so
  // a non-empty selection here is one this note belongs to.
  const selection = multiSelection.length ? multiSelection : null;

  async function update(patch: {
    pinned?: boolean;
    archived?: boolean;
    tagIds?: string[];
  }) {
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

  if (selection) {
    return (
      <ContextMenu
        point={point}
        onClose={onClose}
        header={t('noteList.selectedCount', { count: selection.length })}
        items={
          note.trashedAt
            ? [
                {
                  id: 'restore',
                  label: t('noteActions.restore'),
                  icon: RotateCcw,
                  onSelect: () => void restoreNotesCommand(selection),
                },
              ]
            : [
                {
                  id: 'merge',
                  label: t('bulk.merge'),
                  icon: Combine,
                  onSelect: () => setMergeOpen(true),
                },
                {
                  id: 'export',
                  label: t('export.action'),
                  icon: Share,
                  onSelect: () => setExportOpen(true),
                },
                {
                  id: 'archive',
                  label: t('noteActions.archive'),
                  icon: Archive,
                  onSelect: () => void archiveNotesCommand(selection, true),
                },
                // Tags only, no course list: moving a selection is what
                // dragging it onto the sidebar does, and the selection bar's
                // Move button is where that lives as a click.
                ...(availableTags.length
                  ? [
                      null,
                      ...availableTags.map((tag) => ({
                        id: `tag-${tag.id}`,
                        label: t('noteActions.addTag', { tag: tagLabel(tag, t).full }),
                        icon: Tag,
                        swatch: tag.color,
                        onSelect: () => void tagNotesCommand(selection, tag.id, 'add'),
                      })),
                    ]
                  : []),
                null,
                {
                  id: 'trash',
                  label: t('noteActions.moveToTrash'),
                  icon: Trash2,
                  danger: true,
                  onSelect: () => void trashNotesCommand(selection),
                },
              ]
        }
      />
    );
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
              ...(availableTags.length
                ? [
                    null,
                    ...availableTags.map((tag) => ({
                      id: `tag-${tag.id}`,
                      label: t('noteActions.addTag', { tag: tagLabel(tag, t).full }),
                      icon: Tag,
                      swatch: tag.color,
                      onSelect: () => void update({ tagIds: [...note.tagIds, tag.id] }),
                    })),
                  ]
                : []),
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
