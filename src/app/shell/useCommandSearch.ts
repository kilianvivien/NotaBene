import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  APP_COMMAND_IDS,
  APP_COMMANDS,
  isCommandAvailable,
  runAppCommand,
  searchNotesCommand,
  type AppCommandId,
} from '@/lib/commands';
import { library } from '@/lib/adapters';
import type { NoteSummary, Task } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';

export type CommandSearchRow =
  | { kind: 'note'; id: string; title: string; snippet: string }
  | { kind: 'task'; id: string; title: string; snippet: string; done: boolean }
  | { kind: 'action'; id: AppCommandId; label: string; keys: string | null };

/** Tasks are the shorter, sparser index; a handful is enough to be useful
 * without pushing the notes that match off the bottom of the dropdown. */
const TASK_RESULT_LIMIT = 5;

/** Tauri accelerator syntax as the symbols a Mac menu would show. */
export function commandShortcut(accelerator: string | undefined): string | null {
  if (!accelerator) return null;
  return accelerator
    .split('+')
    .map((part) => {
      const key = part.toLowerCase();
      if (key === 'cmdorctrl' || key === 'cmd') return '⌘';
      if (key === 'shift') return '⇧';
      if (key === 'alt' || key === 'option') return '⌥';
      if (key === 'ctrl') return '⌃';
      if (key === 'slash') return '/';
      return part.toUpperCase();
    })
    .join('');
}

/**
 * The shared search behind both ⌘K and the title-bar field. Keeping note
 * lookup, command filtering, limits, and labels here prevents the two entry
 * points from quietly becoming different products again.
 */
export function useCommandSearch(query: string, enabled = true): CommandSearchRow[] {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  /** Debounced, and guarded against an earlier search resolving last. */
  useEffect(() => {
    if (!enabled) return;
    const term = query.trim();
    if (!term) {
      setNotes([]);
      setTasks([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void searchNotesCommand(term).then((result) => {
        if (live && result.ok) setNotes(result.value);
      });
      // Its own index (`tasks_fts`), so its own call. A failure here must not
      // cost the student their note results.
      void library
        .searchTasks(term, TASK_RESULT_LIMIT)
        .then((found) => {
          if (live) setTasks(found);
        })
        .catch(() => {});
    }, 90);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [enabled, query]);

  const actions = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return APP_COMMAND_IDS.filter(
      (id) => id !== 'app.commandPalette' && isCommandAvailable(id),
    )
      .map((id) => ({
        id,
        label: t(APP_COMMANDS[id].labelKey),
        keys: commandShortcut(APP_COMMANDS[id].accelerator),
      }))
      .filter((entry) => !term || entry.label.toLocaleLowerCase().includes(term))
      .slice(0, term ? 6 : 8);
  }, [query, t]);

  return useMemo(
    () => [
      ...notes.map((note) => ({
        kind: 'note' as const,
        id: note.id,
        title: note.title || t('noteList.untitled'),
        snippet: note.snippet ?? '',
      })),
      ...tasks.map((task) => ({
        kind: 'task' as const,
        id: task.id,
        title: task.title,
        snippet: task.details.slice(0, 200),
        done: task.status === 'done',
      })),
      ...actions.map((entry) => ({ kind: 'action' as const, ...entry })),
    ],
    [notes, tasks, actions, t],
  );
}

export async function chooseCommandSearchRow(row: CommandSearchRow): Promise<void> {
  if (row.kind === 'note') {
    useUiStore.getState().selectNote(row.id);
    await useEditorStore.getState().openNote(row.id);
  } else if (row.kind === 'task') {
    useUiStore.getState().openTasksView({ taskId: row.id });
  } else {
    await runAppCommand(row.id);
  }
}
