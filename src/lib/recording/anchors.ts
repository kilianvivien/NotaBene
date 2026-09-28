/**
 * The anchor a block carries when it was started during a lecture recording
 * (plan §10.0 item 4). Pure helpers, shared by the editor extension that sets
 * anchors and the player that follows them.
 */
export interface AudioAnchor {
  recordingId: string;
  offsetMs: number;
}

/** `recordingId@offsetMs` in HTML, the object in JSON. */
export function parseAudioAnchor(value: unknown): AudioAnchor | null {
  if (typeof value === 'string') {
    const match = /^([A-Za-z0-9_-]{1,64})@(\d{1,10})$/.exec(value);
    return match ? { recordingId: match[1]!, offsetMs: Number(match[2]) } : null;
  }
  if (value && typeof value === 'object') {
    const { recordingId, offsetMs } = value as Record<string, unknown>;
    if (
      typeof recordingId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(recordingId) &&
      typeof offsetMs === 'number' &&
      Number.isInteger(offsetMs) &&
      offsetMs >= 0
    ) {
      return { recordingId, offsetMs };
    }
  }
  return null;
}

/** Where a marker starts playing: two seconds before the anchor, because the
 * sentence that prompted the note began before the first keystroke. */
export const LEAD_IN_MS = 2_000;

/** `1:02:03` or `4:05`. */
export function formatOffset(offsetMs: number): string {
  const total = Math.max(0, Math.floor(offsetMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
