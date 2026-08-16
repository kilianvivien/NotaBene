/**
 * Task reminders.
 *
 * A poll, not a timer ladder. `setTimeout` for "in nine hours" is the obvious
 * design and the wrong one: it does not survive the machine sleeping, which is
 * exactly what a laptop does between a reminder being set in the evening and
 * coming due the next morning. A thirty-second sweep asking the store "what is
 * due?" costs an indexed lookup and cannot drift.
 *
 * The same sweep is what delivers reminders missed while the app was closed.
 * The first pass after launch finds everything whose time has passed and
 * delivers it as one grouped notification rather than a stack of six; from then
 * on each pass finds at most the last thirty seconds' worth. `remindedAt` is
 * what makes each one fire exactly once, across a quit and relaunch.
 *
 * Nothing here runs while the app is closed, and nothing here should: a
 * background service is precisely what NotaBene has decided not to be. The
 * settings copy says so in as many words.
 */
import i18n from '@/lib/i18n';
import { library, notifications } from '@/lib/adapters';
import { applyTaskUpdate } from '@/lib/commands/taskCommands';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore } from '@/lib/state/settingsStore';

const SWEEP_MS = 30_000;

/** Beyond this, the notification names the count instead of the tasks. */
const MAX_NAMED_TASKS = 3;

/**
 * Deliver whatever is due, once.
 *
 * Exported for the tests and for a caller that wants an immediate pass; the
 * scheduler below is just this on a timer.
 */
export async function sweepReminders(): Promise<number> {
  if (!useSettingsStore.getState().settings.taskRemindersEnabled) return 0;

  let due;
  try {
    due = await library.listDueReminders();
  } catch {
    // A locked or read-only library is not an error worth surfacing on a
    // background pass; the next one will find the same tasks.
    return 0;
  }
  if (!due.length) return 0;

  // Stamp first, notify second. The other order risks a crash between the two
  // leaving a reminder that has been seen but not recorded, which would fire
  // again at next launch — and a duplicate reminder is worse than a late one.
  const delivered: typeof due = [];
  const stampedAt = new Date().toISOString();
  for (const task of due) {
    const result = await applyTaskUpdate({
      taskId: task.id,
      remindedAt: stampedAt,
      baseUpdatedAt: task.updatedAt,
    });
    // A conflict means the task moved under us — the student is editing it, or
    // an agent is. Leave it for the next pass rather than stamping over them.
    if (result.ok) delivered.push(task);
  }
  if (!delivered.length) return 0;

  await useLibraryStore.getState().refreshTasks().catch(() => {});
  // A notification that cannot be shown is a missed reminder, not a failed
  // sweep. The interval below calls this without awaiting it, so letting a
  // rejection escape would be an unhandled one — and the pass has already done
  // its durable work by here.
  await notifications
    .notify({
      title: i18n.t('tasks.reminderGroupTitle'),
      body: describe(delivered.map((task) => task.title)),
    })
    .catch(() => {});
  return delivered.length;
}

/**
 * One notification for the whole batch.
 *
 * Six separate banners for six reminders is how a student turns notifications
 * off, so past a handful the count stands in for the titles.
 */
function describe(titles: string[]): string {
  if (titles.length <= MAX_NAMED_TASKS) return titles.join(' · ');
  return i18n.t('tasks.reminderMissed', { count: titles.length });
}

/**
 * Start sweeping. Returns the stop function, in the shape `App.tsx` already
 * uses for the agent bridge and the status watch.
 */
export function startReminderScheduler(): () => void {
  // The first pass is the catch-up, and it runs immediately rather than in
  // thirty seconds: a reminder from last night should be waiting when the
  // window appears, not half a minute later.
  void sweepReminders();
  const timer = window.setInterval(() => void sweepReminders(), SWEEP_MS);
  return () => window.clearInterval(timer);
}

/**
 * Ask for notification permission the first time a reminder is set.
 *
 * Not at launch: a permission prompt before the student has expressed any
 * interest in reminders is the kind of thing that gets refused permanently.
 * Returns whether reminders can actually be delivered, so the caller can say so.
 */
export async function ensureReminderPermission(): Promise<boolean> {
  if (await notifications.isPermitted()) return true;
  return notifications.requestPermission();
}
