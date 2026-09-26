/**
 * Words the student took with Tab, remembered so they rank higher next time.
 *
 * A per-device preference, not library data: it lives in the webview's own
 * storage, never in a backup or an export, and losing it only means the
 * completer relearns a habit. It holds folded keys and counts — no note text.
 */

const STORAGE_KEY = 'notabene.completion-learned.v1';
/** Per scope. Past this the least-used keys are forgotten first. */
const MAX_KEYS = 400;

interface Learned {
  scopes: Record<string, Record<string, number>>;
  /** Completions accepted anywhere, which retires the `auto` Tab hint. */
  accepted: number;
}

let cache: Learned | null = null;

function isCounts(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((count) => typeof count === 'number' && count >= 0)
  );
}

function load(): Learned {
  if (cache) return cache;
  cache = { scopes: {}, accepted: 0 };
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof parsed === 'object' && parsed !== null) {
      const { scopes, accepted } = parsed as Partial<Learned>;
      if (typeof accepted === 'number' && accepted >= 0) cache.accepted = accepted;
      if (typeof scopes === 'object' && scopes !== null) {
        for (const [scope, counts] of Object.entries(scopes)) {
          if (isCounts(counts)) cache.scopes[scope] = counts;
        }
      }
    }
  } catch {
    // Unavailable or hand-edited storage: start from nothing.
  }
  return cache;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(load()));
  } catch {
    // A full store costs a ranking boost, never a keystroke.
  }
}

/** `null` is a note with no course, which completes from the library. */
export function learnedScope(courseId: string | null): string {
  return courseId ?? 'library';
}

export function learnedCount(scope: string, key: string): number {
  return load().scopes[scope]?.[key] ?? 0;
}

export function acceptedCompletions(): number {
  return load().accepted;
}

export function recordAcceptedCompletion(scope: string, key: string | null): void {
  const learned = load();
  learned.accepted += 1;
  if (key) {
    const counts = (learned.scopes[scope] ??= {});
    counts[key] = (counts[key] ?? 0) + 1;
    const keys = Object.keys(counts);
    if (keys.length > MAX_KEYS) {
      keys
        .sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0))
        .slice(0, keys.length - MAX_KEYS)
        .forEach((stale) => delete counts[stale]);
    }
  }
  persist();
}

/** Forget every learned word. The hint counter survives: the student still
 * knows what Tab does. */
export function forgetLearnedCompletions(): void {
  load().scopes = {};
  persist();
}

/** Test seam. */
export function resetLearnedCompletions(): void {
  cache = null;
}
