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
 *    heading section rather than sliced off the front — losing the explanation
 *    around the paragraph the student asked about is the failure chunking is
 *    prone to.
 */
import { docToMarkdown } from '@/editor/markdown';
import type { DocNode, NoteDoc } from '@/lib/schema';
import { fold } from '@/lib/search/fold';
import { estimateTokens, MAX_INPUT_TOKENS } from './client';

/** How wide a question is allowed to look. */
export type AskScope = 'note' | 'course' | 'library';

/** A candidate with the combined score that decided its place. */
export type FusedCandidate = Candidate & {
  /** Roughly 0–1: the weights below sum to one. Comparable within one
   * retrieval, meaningless between two. */
  fused: number;
  /** Normalised text contribution before its weight is applied. */
  normalizedTextScore: number;
  /** Recency contribution before its weight is applied. */
  recencyScore: number;
};

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
  /**
   * Raw relevance, carried for the development-only score readout in the panel.
   * Meaningless across queries, and deliberately not shown to students — it is
   * here so that "retrieval missed" can be told apart from "retrieval ranked it
   * just below the cut", which is the one question tuning depends on.
   */
  score: number;
  /** Stable, provider-independent explanation of why this source was packed. */
  trace: RetrievalSourceTrace;
}

export interface RetrievalSourceTrace {
  matchedKeywords: string[];
  rawTextScore: number;
  normalizedTextScore: number;
  linked: boolean;
  recencyScore: number;
  fusedScore: number;
  /** The semantic section selected when the whole note did not fit. */
  section: {
    heading: string | null;
    startBlock: number;
    endBlock: number;
  } | null;
}

export interface RetrievalTrace {
  scope: AskScope;
  keywords: string[];
  sourceBudgetTokens: number;
  candidatesConsidered: number;
  sourcesSelected: number;
}

export interface RetrievalResult {
  sources: RetrievedSource[];
  keywords: string[];
  /** Candidates that lost the budget race — powers the "+N more" hint. */
  droppedCount: number;
  trace: RetrievalTrace;
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
): FusedCandidate[] {
  const ranked = candidates.filter((candidate) => candidate.noteId !== anchorNoteId);
  if (!ranked.length) return [];

  const scores = ranked.map((candidate) => candidate.score);
  const lowest = Math.min(...scores);
  const highest = Math.max(...scores);
  const spread = highest - lowest;

  return [...ranked]
    .map((candidate) => {
      const normalizedTextScore =
        spread > 0 ? (candidate.score - lowest) / spread : candidate.score > 0 ? 1 : 0;
      const recencyScore = recencyWeight(candidate.updatedAt, now);
      return {
        candidate,
        normalizedTextScore,
        recencyScore,
        fused:
          W_TEXT * normalizedTextScore +
          W_LINK * (candidate.linked ? 1 : 0) +
          W_RECENCY * recencyScore,
      };
    })
    .sort((a, b) =>
      b.fused === a.fused
        ? b.candidate.updatedAt.localeCompare(a.candidate.updatedAt)
        : b.fused - a.fused,
    )
    .map((entry) => ({
      ...entry.candidate,
      fused: entry.fused,
      normalizedTextScore: entry.normalizedTextScore,
      recencyScore: entry.recencyScore,
    }));
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
  ranked: {
    candidate: Candidate &
      Partial<Pick<FusedCandidate, 'fused' | 'normalizedTextScore' | 'recencyScore'>>;
    doc: NoteDoc;
    reason?: RetrievedSource['reason'];
  }[],
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
      // Top of the fused range: the anchor is included by rule, not by rank.
      score: 1,
      trace: {
        matchedKeywords: matchingKeywords(anchor.title, anchor.doc, keywords),
        rawTextScore: 0,
        normalizedTextScore: 0,
        linked: false,
        recencyScore: 0,
        fusedScore: 1,
        section: null,
      },
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
        score: entry.candidate.fused ?? entry.candidate.score,
        trace: sourceTrace(entry.candidate, entry.doc, keywords, null),
      });
      remaining -= whole;
      continue;
    }

    const window = headingSectionWindow(entry.doc, keywords, remaining);
    if (!window) {
      dropped += 1;
      continue;
    }
    sources.push({
      noteId: entry.candidate.noteId,
      title: entry.candidate.title,
      courseId: entry.candidate.courseId,
      doc: window.doc,
      reason: entry.reason ?? (entry.candidate.linked ? 'link' : 'search'),
      truncated: true,
      score: entry.candidate.fused ?? entry.candidate.score,
      trace: sourceTrace(entry.candidate, entry.doc, keywords, {
        heading: window.heading,
        startBlock: window.startBlock,
        endBlock: window.endBlock,
      }),
    });
    remaining -= estimateTokens(docToMarkdown(window.doc));
  }

  return { sources, droppedCount: dropped };
}

export interface HeadingSectionWindow {
  doc: NoteDoc;
  /** Heading of the best-matching section, or `null` for a preamble/unheaded note. */
  heading: string | null;
  /** Inclusive top-level block indexes in the source document. */
  startBlock: number;
  endBlock: number;
}

interface HeadingSection extends HeadingSectionWindow {
  markdown: string;
  tokens: number;
}

/**
 * The contiguous run of heading sections around the best-matching one that
 * fits in `budgetTokens`.
 *
 * Headings are semantic boundaries; top-level editor blocks are not. Keeping
 * a heading with all of its following prose gives the model the claim and its
 * explanation together. An unheaded note is one section and is therefore
 * either sent whole or skipped — silently slicing arbitrary paragraphs would
 * reintroduce the old behaviour this function replaces.
 */
export function headingSectionWindow(
  doc: NoteDoc,
  keywords: string[],
  budgetTokens: number,
): HeadingSectionWindow | null {
  const sections = headingSections(doc);
  if (!sections.length) return null;

  const best = bestSectionIndex(sections, keywords);
  let low = best;
  let high = best;
  let used = sections[best]?.tokens ?? Infinity;
  if (used > budgetTokens) return null;

  // Grow by the cheaper neighbour so the window stays centred on the match
  // while spending the budget on complete semantic units.
  while (low > 0 || high < sections.length - 1) {
    const before = low > 0 ? (sections[low - 1]?.tokens ?? Infinity) : Infinity;
    const after =
      high < sections.length - 1 ? (sections[high + 1]?.tokens ?? Infinity) : Infinity;
    const takeBefore = before <= after;
    const cost = takeBefore ? before : after;
    if (!Number.isFinite(cost) || used + cost > budgetTokens) break;
    used += cost;
    if (takeBefore) low -= 1;
    else high += 1;
  }

  const first = sections[low];
  const last = sections[high];
  const matched = sections[best];
  if (!first || !last || !matched) return null;
  return {
    doc: { type: 'doc', content: doc.content.slice(first.startBlock, last.endBlock + 1) },
    heading: matched.heading,
    startBlock: first.startBlock,
    endBlock: last.endBlock,
  };
}

function headingSections(doc: NoteDoc): HeadingSection[] {
  if (!doc.content.length) return [];
  const starts = [0];
  for (let index = 1; index < doc.content.length; index += 1) {
    if (doc.content[index]?.type === 'heading') starts.push(index);
  }

  return starts.map((startBlock, position) => {
    const endBlock = (starts[position + 1] ?? doc.content.length) - 1;
    const content = doc.content.slice(startBlock, endBlock + 1);
    const first = content[0];
    const markdown = docToMarkdown({ type: 'doc', content });
    return {
      doc: { type: 'doc', content },
      heading: first?.type === 'heading' ? nodeText(first) : null,
      startBlock,
      endBlock,
      markdown,
      tokens: estimateTokens(markdown),
    };
  });
}

function bestSectionIndex(sections: HeadingSection[], keywords: string[]): number {
  if (!keywords.length) return 0;
  let best = 0;
  let bestHits = -1;
  sections.forEach((section, index) => {
    const folded = fold(section.markdown);
    const heading = fold(section.heading ?? '');
    const hits = keywords.reduce(
      (total, term) =>
        total + (folded.includes(term) ? 1 : 0) + (heading.includes(term) ? 1 : 0),
      0,
    );
    if (hits > bestHits) {
      bestHits = hits;
      best = index;
    }
  });
  return best;
}

function nodeText(node: DocNode): string {
  return `${node.text ?? ''}${(node.content ?? []).map(nodeText).join('')}`;
}

function matchingKeywords(title: string, doc: NoteDoc, keywords: string[]): string[] {
  const haystack = fold(`${title}\n${docToMarkdown(doc)}`);
  return keywords.filter((keyword) => haystack.includes(keyword));
}

function sourceTrace(
  candidate: Candidate &
    Partial<Pick<FusedCandidate, 'fused' | 'normalizedTextScore' | 'recencyScore'>>,
  doc: NoteDoc,
  keywords: string[],
  section: RetrievalSourceTrace['section'],
): RetrievalSourceTrace {
  return {
    matchedKeywords: matchingKeywords(candidate.title, doc, keywords),
    rawTextScore: candidate.score,
    normalizedTextScore: candidate.normalizedTextScore ?? 0,
    linked: candidate.linked,
    recencyScore: candidate.recencyScore ?? 0,
    fusedScore: candidate.fused ?? candidate.score,
    section,
  };
}
