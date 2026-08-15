/**
 * System notifications.
 *
 * The only thing NotaBene sends here is a task reminder, and only while the app
 * is running — there is no background service, and adding one would make a
 * privacy-first local app start itself. A reminder that came due while the app
 * was closed is delivered by the sweep at next launch instead; see
 * `src/lib/tasks/reminderScheduler.ts`.
 */
export interface SystemNotification {
  title: string;
  body: string;
}

export interface NotificationAdapter {
  /** Whether the OS currently allows notifications, without prompting. */
  isPermitted(): Promise<boolean>;
  /**
   * Ask, if the user has not already been asked. Returns what they said —
   * including `false` for a previous refusal, which must not re-prompt.
   */
  requestPermission(): Promise<boolean>;
  /** Best-effort. A refused or unavailable notifier resolves rather than throws:
   * a reminder that cannot be shown must not take down the sweep behind it. */
  notify(notification: SystemNotification): Promise<void>;
}
