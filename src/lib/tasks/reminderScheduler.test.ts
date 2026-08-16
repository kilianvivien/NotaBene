import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { notifications } from '@/lib/adapters';
import { createTaskCommand, updateTaskCommand } from '@/lib/commands';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { sweepReminders } from './reminderScheduler';

/** An hour ago — due, whatever the clock says when the suite runs. */
function overdue(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  useSettingsStore.setState((state) => ({
    ...state,
    settings: { ...state.settings, taskRemindersEnabled: true },
  }));
  vi.restoreAllMocks();
});

describe('sweepReminders', () => {
  it('delivers a reminder that has come due', async () => {
    const notify = vi.spyOn(notifications, 'notify').mockResolvedValue();
    await createTaskCommand({ title: 'Hand in essay', remindAt: overdue() });

    expect(await sweepReminders()).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0].body).toContain('Hand in essay');
  });

  it('fires exactly once, however many times it sweeps', async () => {
    const notify = vi.spyOn(notifications, 'notify').mockResolvedValue();
    await createTaskCommand({ title: 'Hand in essay', remindAt: overdue() });

    await sweepReminders();
    expect(await sweepReminders()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('groups a batch into one notification rather than a stack of banners', async () => {
    const notify = vi.spyOn(notifications, 'notify').mockResolvedValue();
    for (const title of ['One', 'Two', 'Three', 'Four']) {
      await createTaskCommand({ title, remindAt: overdue() });
    }

    expect(await sweepReminders()).toBe(4);
    expect(notify).toHaveBeenCalledTimes(1);
    // Past a handful the count stands in for the titles.
    expect(notify.mock.calls[0]?.[0].body).toMatch(/4/);
  });

  it('leaves a completed task alone', async () => {
    const notify = vi.spyOn(notifications, 'notify').mockResolvedValue();
    const created = await createTaskCommand({
      title: 'Hand in essay',
      remindAt: overdue(),
    });
    if (!created.ok) throw new Error('fixture failed');
    await updateTaskCommand({ taskId: created.value.id, status: 'done' });

    expect(await sweepReminders()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does nothing at all when reminders are switched off', async () => {
    const notify = vi.spyOn(notifications, 'notify').mockResolvedValue();
    useSettingsStore.setState((state) => ({
      ...state,
      settings: { ...state.settings, taskRemindersEnabled: false },
    }));
    await createTaskCommand({ title: 'Hand in essay', remindAt: overdue() });

    expect(await sweepReminders()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores a reminder still in the future', async () => {
    const notify = vi.spyOn(notifications, 'notify').mockResolvedValue();
    await createTaskCommand({
      title: 'Hand in essay',
      remindAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    expect(await sweepReminders()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('survives a notifier that fails, and still records the delivery', async () => {
    // A refused notification is a missed reminder, not a failed sweep. The
    // scheduler calls this without awaiting, so a rejection escaping here would
    // be an unhandled one — and the stamp must still land, or the next pass
    // repeats a reminder the student has already dealt with.
    vi.spyOn(notifications, 'notify').mockRejectedValue(new Error('denied'));
    await createTaskCommand({ title: 'Hand in essay', remindAt: overdue() });

    await expect(sweepReminders()).resolves.toBe(1);
    const [task] = await memoryLibraryAdapter.listTasks({});
    expect(task?.remindedAt).not.toBeNull();
  });
});
