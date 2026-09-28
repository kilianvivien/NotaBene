/**
 * A transcript as note content (plan §10.3).
 *
 * Each paragraph carries the same `audioAnchor` a block typed during the
 * lecture does, so the markers and the player 1.3 ships play the lecture
 * from any paragraph with no playback code of their own. Words the engine
 * was unsure of are highlighted for review — only where it reported a real
 * confidence; a missing one is never read as a low one.
 */
import type { DocNode } from '@/lib/schema';
import type { TranscriptParagraph } from './paragraphs';

/** Below this, a word is worth a second listen. Apple's recogniser scores a
 * clean word in the high 0.9s and a misheard one well under 0.5. */
export const REVIEW_CONFIDENCE = 0.5;

const REVIEW_MARK = { type: 'highlight', attrs: { color: 'var(--nb-mark)' } };

function flagged(confidence: number | null): boolean {
  return confidence !== null && confidence < REVIEW_CONFIDENCE;
}

/** Paragraph content, joining consecutive doubtful words into one highlight
 * so a misheard phrase is one passage to review, not five. */
function paragraphContent(paragraph: TranscriptParagraph): {
  content: DocNode[];
  passages: number;
} {
  const content: DocNode[] = [];
  let passages = 0;
  let run: { text: string; marked: boolean } | null = null;
  const push = () => {
    if (!run) return;
    content.push(
      run.marked
        ? { type: 'text', text: run.text, marks: [REVIEW_MARK] }
        : { type: 'text', text: run.text },
    );
  };
  paragraph.words.forEach((word, index) => {
    const marked = flagged(word.confidence);
    const separator = index === 0 ? '' : ' ';
    if (run && run.marked === marked) {
      run.text += separator + word.text;
      return;
    }
    // The space belongs to the plain side, so a highlight starts on a word.
    if (run && !run.marked) run.text += separator;
    push();
    run = { text: run && run.marked ? separator + word.text : word.text, marked };
    if (marked) passages += 1;
  });
  push();
  return { content, passages };
}

export function transcriptBlocks(
  paragraphs: TranscriptParagraph[],
  recordingId: string,
): { blocks: DocNode[]; passages: number } {
  let passages = 0;
  const blocks = paragraphs.map((paragraph) => {
    const built = paragraphContent(paragraph);
    passages += built.passages;
    return {
      type: 'paragraph',
      attrs: { audioAnchor: { recordingId, offsetMs: paragraph.startMs } },
      content: built.content,
    };
  });
  return { blocks, passages };
}
