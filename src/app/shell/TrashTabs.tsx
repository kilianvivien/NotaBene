/**
 * The switch between the two halves of Trash.
 *
 * Notes and tasks both end up in the bin, and they do not share a row shape —
 * one has a snippet and a date, the other a deadline and a checkbox. Rather
 * than invent a hybrid row, the column shows one kind at a time and this says
 * which. It renders in the header of whichever list is on screen, so the other
 * half is always one click away and never invisible.
 */
import { useTranslation } from 'react-i18next';
import { GlassSegmentedControl } from '@/components/glass';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';

export function TrashTabs() {
  const { t } = useTranslation();
  const trashTab = useUiStore((state) => state.trashTab);
  const setTrashTab = useUiStore((state) => state.setTrashTab);
  const trashedTasks = useLibraryStore((state) => state.trashedTasks);

  return (
    <GlassSegmentedControl<'notes' | 'tasks'>
      label={t('trash.tabsLabel')}
      value={trashTab}
      onChange={setTrashTab}
      options={[
        { value: 'notes', label: t('trash.notes') },
        {
          value: 'tasks',
          label: trashedTasks.length
            ? t('trash.tasksWithCount', { count: trashedTasks.length })
            : t('trash.tasks'),
        },
      ]}
      fill
    />
  );
}
