import { create } from 'zustand';
import type { MeetingOccurrence } from '@/lib/timetable/meetings';

/**
 * The meeting happening now, or about to (plan §4 item 2). Derived on every
 * pass of the reminder poll and whenever the courses change — never stored —
 * so the sidebar's Now line is a read of this and nothing else.
 */
interface LectureState {
  current: MeetingOccurrence | null;
  /** Whether it has begun — "Now" — or is in its ten-minute lead — "At 10:00". */
  started: boolean;
}

export const useLectureStore = create<LectureState>(() => ({
  current: null,
  started: false,
}));
