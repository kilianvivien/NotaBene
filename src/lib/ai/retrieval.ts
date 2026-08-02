/**
 * Choosing which notes answer a question.
 *
 * Pure: no adapter, no I/O. `src/lib/ai/*` never reaches for the library —
 * `ask.ts` is handed its sources and the command layer fetches them — and
 * keeping that true is what makes ranking and packing testable without a store.
 * The I/O half lives in `src/lib/commands/retrievalCommands.ts`.
 *
 * Two rules shape everything here:
 *
 * 1. **The anchor is never displaced.** The note the student has open goes in
 *    first and whole, whatever the ranking says. That is what keeps the
 *    single-note guarantee (`ask.ts`) intact inside every wider scope.
 * 2. **Whole notes, until they will not fit.** A note is chunked only when it
 *    cannot be sent entire, and then the window is centred on its best-matching
 *    block rather than sliced off the front — losing the paragraph the student
 *    asked about is the specific failure chunking is prone to.
 */
import { docToMarkdown } from '@/editor/markdown';
import type { NoteDoc } from '@/lib/schema';
import { fold } from '@/lib/search/fold';
import { estimateTokens, MAX_INPUT_TOKENS } from './client';
import { docToBlocks } from './rewrite';

/** How wide a question is allowed to look. */
export type AskScope = 'note' | 'course' | 'library';

/** A note that might answer, before its document has been fetched. */
export interface Candidate {
  noteId: string;
  title: string;
  courseId: string | null;
  updatedAt: string;
  /** Raw relevance from the ranked search; 0 for link-only candidates. */
  score: number;
  /** Wiki-linked to the anchor, in either direction. */
  linked: boolean;
}

export interface RetrievedSource {
  noteId: string;
  title: string;
  courseId: string | null;
  doc: NoteDoc;
  reason: 'anchor' | 'search' | 'link' | 'recent';
  /** Set when the note did not fit whole and a block window was taken. */
  truncated: boolean;
}

export interface RetrievalResult {
  sources: RetrievedSource[];
  keywords: string[];
  /** Candidates that lost the budget race — powers the "+N more" hint. */
  droppedCount: number;
}

export interface AnchorNote {
  noteId: string;
  title: string;
  courseId: string | null;
  doc: NoteDoc;
}

/**
 * Deliberately far below `MAX_INPUT_TOKENS`, which is a refusal ceiling rather
 * than a budget. Every wide-scope turn bills the whole packed context against
 * the student's own key, and a model answers a focused 32k prompt better than a
 * 150k one. In practice `MAX_SOURCES` binds first: class notes run a couple of
 * thousand tokens each.
 */
export const ASK_SOURCE_BUDGET_TOKENS = 32_000;

export const MAX_SOURCES = 12;

/** Below this a source contributes noise rather than context. */
const MIN_SOURCE_TOKENS = 600;

/** Room for the system prompt's own scaffolding around the notes. */
const PROMPT_OVERHEAD_TOKENS = 1_500;

const W_TEXT = 0.75;
const W_LINK = 0.15;
const W_RECENCY = 0.1;

/** Days after which a note's recency contribution has halved. */
const RECENCY_HALF_LIFE_DAYS = 90;

/**
 * How many tokens the sources may take, given what else is going in the prompt.
 * A long conversation shrinks the context rather than pushing the request over
 * the limit and failing outright.
 */
export function sourceBudget(historyAndQuestion: string): number {
  const spoken = estimateTokens(historyAndQuestion);
  return Math.max(
    MIN_SOURCE_TOKENS,
    Math.min(
      ASK_SOURCE_BUDGET_TOKENS,
      MAX_INPUT_TOKENS - spoken - PROMPT_OVERHEAD_TOKENS,
    ),
  );
}

/**
 * Order candidates by relevance, links and recency together.
 *
 * Text score is min-max normalised across the set first: bm25 values only mean
 * something relative to the other results of the same query, so mixing raw ones
 * with the other two signals would let one query's scale drown them out.
 *
 * The anchor is removed rather than ranked — it is not competing.
 */
export function fuseCandidates(
  candidates: Candidate[],
  anchorNoteId: string,
  now: Date = new Date(),
): Candidate[] {
  const ranked = candidates.filter((candidate) => candidate.noteId !== anchorNoteId);
  if (!ranked.length) return [];

  const scores = ranked.map((candidate) => candidate.score);
  const lowest = Math.min(...scores);
  const highest = Math.max(...scores);
  const spread = highest - lowest;

  return [...ranked]
    .map((candidate) => ({
      candidate,
      fused:
        W_TEXT * (spread > 0 ? (candidate.score - lowest) / spread : candidate.score > 0 ? 1 : 0) +
        W_LINK * (candidate.linked ? 1 : 0) +
        W_RECENCY * recencyWeight(candidate.updatedAt, now),
    }))
    .sort((a, b) =>
      b.fused === a.fused
        ? b.candidate.updatedAt.localeCompare(a.candidate.updatedAt)
        : b.fused - a.fused,
    )
    .map((entry) => entry.candidate);
}

function recencyWeight(updatedAt: string, now: Date): number {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return 0;
  const days = Math.max(0, (now.getTime() - then) / 86_400_000);
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Fill the prompt's source list, anchor first, under a token budget.
 *
 * `ranked` is expected in fused order and to exclude the anchor.
 */
export function packSources(
  anchor: AnchorNote,
  ranked: { candidate: Candidate; doc: NoteDoc; reason?: RetrievedSource['reason'] }[],
  keywords: string[],
  budgetTokens: number,
): { sources: RetrievedSource[]; droppedCount: number } {
  const sources: RetrievedSource[] = [
    {
      noteId: anchor.noteId,
      title: anchor.title,
      courseId: anchor.courseId,
      doc: anchor.doc,
      reason: 'anchor',
      truncated: false,
    },
  ];

  // The anchor is not optional, so it is spent before the budget is consulted.
  let remaining = budgetTokens - estimateTokens(docToMarkdown(anchor.doc));
  let dropped = 0;

  for (const entry of ranked) {
    if (sources.length >= MAX_SOURCES || remaining <= MIN_SOURCE_TOKENS) {
      dropped += 1;
      continue;
    }

    const whole = estimateTokens(docToMarkdown(entry.doc));
    if (whole <= remaining) {
      sources.push({
        noteId: entry.candidate.noteId,
        title: entry.candidate.title,
        courseId: entry.candidate.courseId,
        doc: entry.doc,
        reason: entry.reason ?? (entry.candidate.linked ? 'link' : 'search'),
        truncated: false,
      });
      remaining -= whole;
      continue;
    }

    const window = blockWindow(entry.doc, keywords, remaining);
    if (!window) {
      dropped += 1;
      continue;
    }
    sources.push({
      noteId: entry.candidate.noteId,
      title: entry.candidate.title,
      courseId: entry.candidate.courseId,
      doc: window,
      reason: entry.reason ?? (entry.candidate.linked ? 'link' : 'search'),
      truncated: true,
    });
    remaining -= estimateTokens(docToMarkdown(window));
  }

  return { sources, droppedCount: dropped };
}

/**
 * The contiguous run of blocks around the best-matching one that fits in
 * `budgetTokens`, or `null` if even that block is too big.
 *
 * Growing outwards from the match — rather than taking the first N blocks —
 * is what keeps the passage the student asked about, plus the context that
 * makes it readable, instead of whatever happened to open the note.
 */
export function blockWindow(
  doc: NoteDoc,
  keywords: string[],
  budgetTokens: number,
): NoteDoc | null {
  const blocks = docToBlocks(doc);
  if (!blocks.length) return null;

  const best = bestBlockIndex(blocks, keywords);
  let low = best;
  let high = best;
  let used = estimateTokens(blocks[best] ?? '');
  if (used > budgetTokens) return null;

  // Alternate outwards so the window stays centred on the match.
  while (low > 0 || high < blocks.length - 1) {
    const before = low > 0 ? estimateTokens(blocks[low - 1] ?? '') : Infinity;
    const after = high < blocks.length - 1 ? estimateTokens(blocks[high + 1] ?? '') : Infinity;
    const takeBefore = before <= after;
    const cost = takeBefore ? before : after;
    if (!Number.isFinite(cost) || used + cost > budgetTokens) break;
    used += cost;
    if (takeBefore) low -= 1;
    else high += 1;
  }

  return { type: 'doc', content: doc.content.slice(low, high + 1) };
}

function bestBlockIndex(blocks: string[], keywords: string[]): number {
  if (!keywords.length) return 0;
  let best = 0;
  let bestHits = -1;
  blocks.forEach((block, index) => {
    const folded = fold(block);
    const hits = keywords.filter((term) => folded.includes(term)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = index;
    }
  });
  return best;
}
