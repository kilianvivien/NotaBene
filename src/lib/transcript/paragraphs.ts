/**
 * Group a transcript into paragraphs a student can read and click (plan
 * §10.3).
 *
 * A paragraph ends where a sentence ends *and* the speaker paused, or where a
 * sentence ends after about thirty seconds of speech — a lecturer who never
 * pauses still gets paragraphs. A long enough gap ends one regardless, and a
 * hard ceiling stops a transcript without punctuation from becoming one wall.
 * Each paragraph starts at its first unit's time, which becomes its anchor.
 */
import type { TranscriptSegment, TranscriptWord } from '@/lib/schema';

export interface TranscriptParagraph {
  startMs: number;
  endMs: number;
  /** Words where the engine had them; one pseudo-word per segment where it
   * did not, with no confidence. */
  words: TranscriptWord[];
}

export const PARAGRAPH_PAUSE_MS = 2_000;
export const PARAGRAPH_TARGET_MS = 30_000;
const PARAGRAPH_CEILING_MS = 45_000;
const LONG_GAP_MS = 6_000;

const SENTENCE_END = /[.!?…]["»”’)\]]*$/;

function units(segments: TranscriptSegment[]): TranscriptWord[] {
  return segments.flatMap((segment) =>
    segment.words.length
      ? segment.words
      : [
          {
            text: segment.text.trim(),
            start: segment.start,
            end: segment.end,
            confidence: null,
          },
        ],
  );
}

export function groupParagraphs(segments: TranscriptSegment[]): TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptWord[] = [];

  const close = () => {
    if (!current.length) return;
    paragraphs.push({
      startMs: Math.round(current[0]!.start * 1000),
      endMs: Math.round(current[current.length - 1]!.end * 1000),
      words: current,
    });
    current = [];
  };

  for (const unit of units(segments)) {
    if (!unit.text) continue;
    const previous = current[current.length - 1];
    if (previous) {
      const gap = (unit.start - previous.end) * 1000;
      const span = (unit.start - current[0]!.start) * 1000;
      const sentenceDone = SENTENCE_END.test(previous.text);
      if (
        (sentenceDone && gap >= PARAGRAPH_PAUSE_MS) ||
        (sentenceDone && span >= PARAGRAPH_TARGET_MS) ||
        gap >= LONG_GAP_MS ||
        span >= PARAGRAPH_CEILING_MS
      ) {
        close();
      }
    }
    current.push(unit);
  }
  close();
  return paragraphs;
}
