/**
 * Built vocabularies, one per course, kept between keystrokes.
 *
 * A read cache in the same sense as `libraryStore`: never a source of truth,
 * rebuilt from the notes and the course's curated terms whenever it might be
 * behind them. Not a Zustand store, because nothing renders from it — the
 * editor asks it synchronously on a keystroke and gets either an index or
 * nothing, and a missing index only means no suggestion yet.
 *
 * Rebuilding happens when the editor is idle and never inside a transaction.
 * A course's vocabulary goes stale in two ways: a curated term changes, which
 * the command layer reports through `invalidateVocabulary` so the next word
 * typed sees it; and the notes change, which is simply given time — words
 * typed in this lecture reach the index within `STALE_AFTER_MS`, or as soon
 * as the next note is opened (`OPEN_REFRESH_MS`), which is soon enough for a
 * word that was not in the vocabulary a minute ago either.
 */
import { library } from '@/lib/adapters';
import type { CourseTerm } from '@/lib/schema';
import { buildCompletionIndex, type CompletionIndex } from './completionIndex';
import {
  HARVEST_DEFAULTS,
  LIBRARY_HARVEST,
  createHarvester,
  type HarvestOptions,
  type HarvestedTerm,
} from './harvest';

export const STALE_AFTER_MS = 2 * 60_000;

/** Longest the harvest holds the thread before handing it back. Under a
 * frame, so a build running while the student types never drops a key. */
const SLICE_MS = 12;

/** Map key for notes that have no course: they complete from the library. */
const LIBRARY_SCOPE = '\u0000library';

interface Entry {
  index: CompletionIndex | null;
  builtAt: number;
  /** Set by `invalidateVocabulary`; the next read rebuilds regardless of age. */
  stale: boolean;
  building: Promise<CompletionIndex> | null;
}

const entries = new Map<string, Entry>();
/** Bumped by `resetVocabularyCache` so a build that started before a reset
 * does not write its result into the fresh cache. */
let generation = 0;

function scopeKey(courseId: string | null): string {
  return courseId ?? LIBRARY_SCOPE;
}

function entryFor(courseId: string | null): Entry {
  const key = scopeKey(courseId);
  let entry = entries.get(key);
  if (!entry) {
    entry = { index: null, builtAt: 0, stale: true, building: null };
    entries.set(key, entry);
  }
  return entry;
}

export interface CourseVocabulary {
  harvested: HarvestedTerm[];
  curated: CourseTerm[];
}

/**
 * Everything a course's vocabulary is made of, read fresh. The dialog shows
 * this directly; the cache folds it into an index.
 */
export async function loadCourseVocabulary(
  courseId: string | null,
): Promise<CourseVocabulary> {
  const [texts, curated, tags] = await Promise.all([
    library.listNoteTexts(courseId),
    library.listCourseTerms(courseId),
    library.listTags(),
  ]);
  const harvested = await harvestInSlices(texts, {
    ...(courseId ? HARVEST_DEFAULTS : LIBRARY_HARVEST),
    keyTerms: tags.map((tag) => tag.name),
  });
  return { harvested, curated };
}

/** The harvest, a few notes at a time, yielding between slices. */
async function harvestInSlices(
  texts: readonly { id: string; title: string; plainText: string }[],
  options: HarvestOptions,
): Promise<HarvestedTerm[]> {
  const harvester = createHarvester(options);
  let sliceStarted = performance.now();
  for (const text of texts) {
    harvester.add(text);
    if (performance.now() - sliceStarted > SLICE_MS) {
      await whenIdle();
      sliceStarted = performance.now();
    }
  }
  return harvester.finish();
}

/** Let the frame that is being typed finish before a harvest takes the
 * thread. `requestIdleCallback` where the webview has it, a timeout where it
 * does not — WebKit only gained it recently. */
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const idle = (
      globalThis as {
        requestIdleCallback?: (
          callback: () => void,
          options?: { timeout: number },
        ) => void;
      }
    ).requestIdleCallback;
    if (idle) idle(() => resolve(), { timeout: 1_000 });
    else setTimeout(resolve, 50);
  });
}

async function build(courseId: string | null): Promise<CompletionIndex> {
  const started = generation;
  await whenIdle();
  const { harvested, curated } = await loadCourseVocabulary(courseId);
  const index = buildCompletionIndex(harvested, curated);
  if (started === generation) {
    const entry = entryFor(courseId);
    entry.index = index;
    entry.builtAt = Date.now();
  }
  return index;
}

/**
 * How old an index may be when a note is opened. Much shorter than
 * `STALE_AFTER_MS`: moving to the next note is when the one just written has
 * been saved, and its words should be there to complete in the new one.
 */
export const OPEN_REFRESH_MS = 10_000;

/**
 * Build the course's index if it is missing, invalidated, or older than
 * `maxAgeMs`, and return it. Concurrent callers share one build.
 */
export function ensureCompletionIndex(
  courseId: string | null,
  maxAgeMs: number = STALE_AFTER_MS,
): Promise<CompletionIndex> {
  const entry = entryFor(courseId);
  const fresh = !entry.stale && Date.now() - entry.builtAt < maxAgeMs;
  if (entry.index && fresh) return Promise.resolve(entry.index);
  if (entry.building) return entry.building;

  entry.stale = false;
  const building = build(courseId).finally(() => {
    if (entryFor(courseId).building === building) entryFor(courseId).building = null;
  });
  entry.building = building;
  // A failed read leaves the previous index in place and tries again on the
  // next keystroke that finds it stale; completion is never worth an error.
  building.catch(() => {
    entryFor(courseId).stale = true;
  });
  return building;
}

/**
 * What the editor calls on a keystroke. Synchronous: it returns whatever is
 * built — possibly a slightly old index — and starts a rebuild in the
 * background when that one has aged out.
 */
export function completionIndexFor(courseId: string | null): CompletionIndex | null {
  const entry = entryFor(courseId);
  const aged = entry.stale || Date.now() - entry.builtAt >= STALE_AFTER_MS;
  if (aged && !entry.building)
    void ensureCompletionIndex(courseId).catch(() => undefined);
  return entry.index;
}

/**
 * Mark a course's vocabulary out of date. With no argument, every course —
 * for a restore, which may have replaced any of them. The last-built index
 * keeps serving until the rebuild lands, so typing never sees a gap.
 */
export function invalidateVocabulary(courseId?: string | null): void {
  if (courseId === undefined) {
    for (const entry of entries.values()) entry.stale = true;
    return;
  }
  entryFor(courseId).stale = true;
  // Notes with no course draw on every course's curated terms.
  if (courseId !== null) entryFor(null).stale = true;
}

/** Test seam, and what a library switch would call. */
export function resetVocabularyCache(): void {
  generation += 1;
  entries.clear();
}
