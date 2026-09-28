/**
 * Join per-window transcripts onto the lecture's clock (plan §10.3).
 *
 * Windows overlap by a few seconds so a word cut at a boundary is heard whole
 * by one of them. Both windows then transcribe the overlap, and the midpoint
 * rule decides who keeps it: window *k* keeps what starts before the
 * overlap's midpoint, window *k+1* what starts at or after it. The unit is a
 * word where the engine has words, a segment where it has only segments.
 *
 * Segments are coarser than words, and two windows can cut the overlap into
 * segments differently, so a segment-only engine gets one more rule: a
 * segment that ends inside what the previous window already covered is a
 * repeat and is dropped. One that runs past it is kept even if it repeats a
 * few words — a duplicated phrase is better than a lost one.
 *
 * TypeScript rather than Rust because hosted engines answer the webview, and
 * one stitcher for every engine beats one per side of the bridge.
 */
import type { TranscriptSegment, TranscriptWord } from '@/lib/schema';
import type { AsrWindow } from '@/lib/adapters';

export interface WindowTranscript {
  window: AsrWindow;
  /** Times relative to the window's start, as the engine returned them. */
  segments: TranscriptSegment[];
}

/** How far past covered ground a segment may end and still be a repeat. */
const REPEAT_TOLERANCE_S = 0.5;

function shiftWord(word: TranscriptWord, offset: number): TranscriptWord {
  return { ...word, start: word.start + offset, end: word.end + offset };
}

/** A segment rebuilt from the words it kept. `null` when it kept none. */
function keepWords(
  segment: TranscriptSegment,
  keep: (start: number) => boolean,
): TranscriptSegment | null {
  if (!segment.words.length) return keep(segment.start) ? segment : null;
  const words = segment.words.filter((word) => keep(word.start));
  if (!words.length) return null;
  if (words.length === segment.words.length) return segment;
  return {
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: words.map((word) => word.text).join(' '),
    words,
  };
}

export function stitchWindows(windows: WindowTranscript[]): TranscriptSegment[] {
  const ordered = [...windows].sort(
    (left, right) => left.window.index - right.window.index,
  );
  const stitched: TranscriptSegment[] = [];
  /** The end of the last kept unit, on the lecture clock. */
  let covered = -Infinity;
  ordered.forEach(({ window, segments }, position) => {
    const offset = window.startMs / 1000;
    const previous = ordered[position - 1]?.window;
    const next = ordered[position + 1]?.window;
    // Midpoints of the overlaps on either side, on the lecture's clock.
    const from = previous ? (window.startMs + previous.endMs) / 2000 : -Infinity;
    const to = next ? (next.startMs + window.endMs) / 2000 : Infinity;
    const keep = (start: number) => start >= from && start < to;

    for (const segment of segments) {
      const shifted: TranscriptSegment = {
        ...segment,
        start: segment.start + offset,
        end: segment.end + offset,
        words: segment.words.map((word) => shiftWord(word, offset)),
      };
      const kept = keepWords(shifted, keep);
      if (!kept || !kept.text.trim()) continue;
      if (!kept.words.length && kept.end <= covered + REPEAT_TOLERANCE_S) continue;
      stitched.push(kept);
      covered = Math.max(covered, kept.end);
    }
  });
  return stitched;
}
