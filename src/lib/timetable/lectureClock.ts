/**
 * The lecture clock (plan §4 item 2): what the Now line shows, and the
 * opt-in notification when a lecture starts.
 *
 * It runs on the reminder poll rather than a timer of its own, for the
 * reminders' reason — a poll survives the laptop sleeping — plus an immediate
 * pass whenever the courses change, so editing a timetable shows at once.
 *
 * Unlike reminders, a lecture notification has **no catch-up**. Being told at
 * 11:40 that a 10:00 lecture started is noise, so a notification goes only in
 * the window from ten minutes before a start to one minute after, once per
 * meeting and day for as long as the app is open.
 */
import i18n from '@/lib/i18n';
import { notifications } from '@/lib/adapters';
import { useLectureStore } from '@/lib/state/lectureStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import {
  currentMeeting,
  lectureKey,
  minutesToTime,
  type MeetingOccurrence,
} from './meetings';

/** How late a start may still be announced: one poll and a half. */
const NOTIFY_GRACE_MS = 60_000;

const notified = new Set<string>();

/** The line a notification and the Now line both say. */
export function describeOccurrence(occurrence: MeetingOccurrence): string {
  return [
    occurrence.meeting.title ?? occurrence.course.name,
    occurrence.meeting.location,
    i18n.t('lecture.until', { time: minutesToTime(occurrence.meeting.end) }),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function sweepLectures(now: Date = new Date()): MeetingOccurrence | null {
  const current = currentMeeting(useLibraryStore.getState().courses, now);
  const before = useLectureStore.getState();
  const started = Boolean(current && current.startsAt.getTime() <= now.getTime());
  if (
    before.current?.meeting !== current?.meeting ||
    before.current?.day !== current?.day ||
    before.current?.course !== current?.course ||
    before.started !== started
  ) {
    useLectureStore.setState({ current, started });
  }

  if (current?.course.lectureNotify) {
    const key = lectureKey(current.meeting.id, current.day);
    const late = now.getTime() - current.startsAt.getTime();
    if (!notified.has(key) && late <= NOTIFY_GRACE_MS) {
      notified.add(key);
      void notifications
        .notify({
          title: i18n.t('lecture.notifyTitle', { course: current.course.name }),
          body: describeOccurrence(current),
        })
        .catch(() => {});
    }
  }
  return current;
}

/** Start following the timetable. Returns the stop function. */
export function watchCourses(): () => void {
  sweepLectures();
  return useLibraryStore.subscribe((state, before) => {
    if (state.courses !== before.courses) sweepLectures();
  });
}

/** For tests: forget which lectures were announced. */
export function resetLectureClock(): void {
  notified.clear();
  useLectureStore.setState({ current: null, started: false });
}
