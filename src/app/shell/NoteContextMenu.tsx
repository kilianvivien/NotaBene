import { Archive, FolderOpen, Pin, PinOff, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { restoreNoteCommand, trashNoteCommand, updateNoteCommand } from '@/lib/commands';
import type { NoteSummary } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';

export interface ContextPoint {
  x: number;
  y: number;
}

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

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);

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

  const x = Math.min(point.x, Math.max(8, window.innerWidth - 210));
  const y = Math.min(point.y, Math.max(8, window.innerHeight - 230));

  return (
    <div
      role="menu"
      className="fixed z-[70] w-[196px] rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-menu-surface)] p-1.5 shadow-[var(--nb-shadow-lg)]"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MenuAction
        icon={FolderOpen}
        label={t('noteActions.open')}
        onClick={() => {
          selectNote(note.id);
          void openNote(note.id);
          onClose();
        }}
      />
      {!note.trashedAt && (
        <>
          <MenuAction
            icon={note.pinned ? PinOff : Pin}
            label={note.pinned ? t('noteActions.unpin') : t('noteActions.pin')}
            onClick={() => {
              void update({ pinned: !note.pinned });
              onClose();
            }}
          />
          <MenuAction
            icon={Archive}
            label={note.archived ? t('noteActions.unarchive') : t('noteActions.archive')}
            onClick={() => {
              void update({ archived: !note.archived });
              onClose();
            }}
          />
          <div className="my-1 border-t border-[var(--nb-divider)]" />
          <MenuAction
            icon={Trash2}
            danger
            label={t('noteActions.moveToTrash')}
            onClick={() => {
              void trashNoteCommand(note.id);
              onClose();
            }}
          />
        </>
      )}
      {note.trashedAt && (
        <MenuAction
          icon={RotateCcw}
          label={t('noteActions.restore')}
          onClick={() => {
            void restoreNoteCommand(note.id);
            onClose();
          }}
        />
      )}
    </div>
  );
}

function MenuAction({
  icon: Icon,
  label,
  danger = false,
  onClick,
}: {
  icon: typeof Pin;
  label: string;
  danger?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex h-8 w-full items-center gap-2 rounded-nb-xs px-2 text-[13px] hover:bg-[var(--nb-hover)] ${
        danger ? 'text-[var(--nb-danger)]' : 'text-nb-text-2'
      }`}
      onClick={onClick}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
