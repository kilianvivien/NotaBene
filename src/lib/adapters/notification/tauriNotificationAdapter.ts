/**
 * Notifications through the Tauri plugin. The plugin import lives here and
 * nowhere else — that is the platform-boundary rule.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { NotificationAdapter, SystemNotification } from './NotificationAdapter';

export const tauriNotificationAdapter: NotificationAdapter = {
  async isPermitted() {
    try {
      return await isPermissionGranted();
    } catch {
      return false;
    }
  },

  async requestPermission() {
    try {
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === 'granted';
    } catch {
      return false;
    }
  },

  async notify(notification: SystemNotification) {
    try {
      if (!(await isPermissionGranted())) return;
      sendNotification({ title: notification.title, body: notification.body });
    } catch {
      // Swallowed on purpose: a reminder that cannot be shown is a missed
      // reminder, not a failed sweep, and the next one must still fire.
    }
  },
};

/** Browser and test builds. Silent, and honest about being unable to notify. */
export const unavailableNotificationAdapter: NotificationAdapter = {
  isPermitted: async () => false,
  requestPermission: async () => false,
  notify: async () => {},
};
