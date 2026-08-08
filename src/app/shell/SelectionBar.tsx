/**
 * What you can do to several notes at once.
 *
 * Sits between the note list's header and its rows, and only exists while a
 * bulk selection does — a permanent bar advertising actions that need a
 * selection is a bar that is wrong most of the time. It carries the count
 * because a virtualised list scrolled away from its highlights is otherwise
 * silent about how many notes an action is about to touch.
 *
 * Two constraints shape the layout, and both come from the pane being narrow:
 *
 * 1. **Three actions inline, the rest behind `⋯`.** Six icon buttons and a
 *    count do not fit in 260px — the count is what loses, and "2 not…" is the
 *    one thing in this bar that must always be legible. Move, tag and merge
 *    are the ones a selection is usually built for; export, archive and trash
 *    are one click further away and reachable from the context menu besides.
 * 2. **The bar is not accent-tinted.** The selected rows already are, and a
 *    band of the same wash directly above them turns the whole pane into one
 *    flat block. It takes the neutral raised tone instead, and spends the
 *    accent on the count, which is the part that means "selection".
 *
 * Move and Tag open the shared `ContextMenu` under their button rather than a
 * bespoke popover, so a bulk move offers the same course list, in the same
 * geometry, as the single-note menu beside it.
 */
import { useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Combine,
  FolderOpen,
  MoreHorizontal,
  RotateCcw,
  Share,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, GlassIconButton, type ContextPoint } from '@/components/glass';
import {
  archiveNotesCommand,
  fileNotesCommand,
  restoreNotesCommand,
  tagNotesCommand,
  trashNotesCommand,
} from '@/lib/commands';
import { tagLabel } from '@/lib/notes/tagLabel';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';

type Menu = 'move' | 'tag' | 'more';

export function SelectionBar() {
  const { t } = useTranslation();
  const view = useUiStore((state) => state.view);
  const selection = useUiStore((state) => state.multiSelection);
  const clearMultiSelection = useUiStore((state) => state.clearMultiSelection);
  const setExportOpen = useUiStore((state) => state.setExportOpen);
  const setMergeOpen = useUiStore((state) => state.setMergeOpen);
  const courses = useLibraryStore((state) => state.courses);
  const tags = useLibraryStore((state) => state.tags);
  const [menu, setMenu] = useState<{ kind: Menu; point: ContextPoint } | null>(null);

  if (selection.length < 2) return null;

  const inTrash = view.kind === 'trash';
  const inArchive = view.kind === 'archived';
  const count = selection.length;

  /** Anchor a menu under the button that opened it, so it reads as belonging
   * to that control rather than appearing wherever the pointer happened to be.
   * `ContextMenu` flips it back inside the window on its own. */
  function openMenu(kind: Menu, element: HTMLElement) {
    const box = element.getBoundingClientRect();
    setMenu({ kind, point: { x: box.left, y: box.bottom + 4 } });
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--nb-divider)] bg-[var(--nb-hover)] px-2">
      {/* `shrink-0`: the count is the one thing here that cannot be clipped,
          so the button group is what gives way on a narrow pane. */}
      <span className="shrink-0 text-[12px] font-medium text-[var(--nb-accent)]">
        {t('noteList.selectedCount', { count })}
      </span>

      <div className="ml-auto flex min-w-0 shrink items-center justify-end">
        {inTrash ? (
          <GlassIconButton
            label={t('noteActions.restore')}
            className="size-7"
            onClick={() => void restoreNotesCommand(selection)}
          >
            <RotateCcw size={14} />
          </GlassIconButton>
        ) : (
          <>
            <GlassIconButton
              label={t('bulk.move')}
              className="size-7"
              onClick={(event) => openMenu('move', event.currentTarget)}
            >
              <FolderOpen size={14} />
            </GlassIconButton>
            <GlassIconButton
              label={tags.length ? t('bulk.tag') : t('bulk.tagNone')}
              className="size-7"
              disabled={tags.length === 0}
              onClick={(event) => openMenu('tag', event.currentTarget)}
            >
              <Tag size={14} />
            </GlassIconButton>
            <GlassIconButton
              label={t('bulk.merge')}
              className="size-7"
              onClick={() => setMergeOpen(true)}
            >
              <Combine size={14} />
            </GlassIconButton>
            <GlassIconButton
              label={t('bulk.more')}
              className="size-7"
              onClick={(event) => openMenu('more', event.currentTarget)}
            >
              <MoreHorizontal size={14} />
            </GlassIconButton>
          </>
        )}
        <span aria-hidden className="mx-1 h-4 w-px bg-[var(--nb-divider-strong)]" />
        <GlassIconButton
          label={t('bulk.clear')}
          className="size-7"
          onClick={clearMultiSelection}
        >
          <X size={14} />
        </GlassIconButton>
      </div>

      {menu?.kind === 'move' && (
        <ContextMenu
          point={menu.point}
          onClose={() => setMenu(null)}
          header={t('bulk.moveHeader', { count })}
          items={[
            {
              id: 'inbox',
              label: t('sidebar.inbox'),
              icon: FolderOpen,
              onSelect: () =>
                void fileNotesCommand(selection, { courseId: null, sectionId: null }),
            },
            ...(courses.length ? [null] : []),
            ...courses.map((course) => ({
              id: course.id,
              label: course.name,
              icon: FolderOpen,
              swatch: course.color,
              onSelect: () =>
                void fileNotesCommand(selection, {
                  courseId: course.id,
                  sectionId: null,
                }),
            })),
          ]}
        />
      )}

      {menu?.kind === 'tag' && (
        <ContextMenu
          point={menu.point}
          onClose={() => setMenu(null)}
          header={t('bulk.tagHeader', { count })}
          items={tags.map((tag) => ({
            id: tag.id,
            label: tagLabel(tag, t).full,
            icon: Tag,
            swatch: tag.color,
            onSelect: () => void tagNotesCommand(selection, tag.id, 'add'),
          }))}
        />
      )}

      {menu?.kind === 'more' && (
        <ContextMenu
          point={menu.point}
          onClose={() => setMenu(null)}
          header={t('noteList.selectedCount', { count })}
          items={[
            {
              id: 'export',
              label: t('export.action'),
              icon: Share,
              onSelect: () => setExportOpen(true),
            },
            {
              id: 'archive',
              label: inArchive ? t('noteActions.unarchive') : t('noteActions.archive'),
              icon: inArchive ? ArchiveRestore : Archive,
              onSelect: () => void archiveNotesCommand(selection, !inArchive),
            },
            null,
            {
              id: 'trash',
              label: t('noteActions.moveToTrash'),
              icon: Trash2,
              danger: true,
              onSelect: () => void trashNotesCommand(selection),
            },
          ]}
        />
      )}
    </div>
  );
}
