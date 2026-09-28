import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';

/**
 * From a lecture note's player to the same moment in its transcript: find
 * the transcript (the note that links here and holds the same audio), open
 * it, and scroll to the paragraph whose anchor precedes the playhead.
 */
export async function openTranscriptAt(
  transcript: { noteId: string; attachmentId: string },
  positionMs: number,
): Promise<void> {
  useUiStore.getState().selectNote(transcript.noteId);
  await useEditorStore.getState().openNote(transcript.noteId);
  // The markers appear once the transcript's player has found its audio.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const markers = [
      ...document.querySelectorAll<HTMLElement>(
        `.nb-audio-anchor[data-recording-id="${CSS.escape(transcript.attachmentId)}"]`,
      ),
    ];
    if (markers.length) {
      const before = markers.filter(
        (marker) => Number(marker.dataset.offsetMs) <= positionMs,
      );
      const marker = before[before.length - 1] ?? markers[0]!;
      marker.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
}
