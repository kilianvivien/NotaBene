/**
 * Reformatting an imported document.
 *
 * AnyDoc hands back the words a PDF or a Word file contained and very little of
 * the shape it had. This is the optional pass that puts the shape back: the
 * converted Markdown goes to the model as numbered blocks — the same machinery
 * as Rewrite, for the same reason — and comes back as per-block layout edits.
 *
 * The promise the feature makes is that the *text* does not change, and a
 * promise a prompt makes alone is not one worth making. Every edit is measured
 * against the block it claims to lay out before it is applied: the words of the
 * source must all survive, the model may add no more than a heading's worth of
 * its own, and nothing may be deleted. An edit that fails is dropped, and the
 * caller is told how many were — a student who imports a handout and gets back
 * a paraphrase of it has lost the one thing the import was for.
 */
import { docToMarkdown, markdownToDoc } from '@/editor/markdown';
import {
  AiRewriteResponseSchema,
  type DocNode,
  type RewriteProposal,
} from '@/lib/schema';
import { runAi, type AiRunOptions } from './client';
import { parseModelJson } from './json';
import { reformatPrompt } from './prompts';
import type { ResolvedProvider } from './protocols';
import {
  applyProposal,
  docToBlocks,
  proposalFromResponse,
  proposalNodes,
} from './rewrite';

/** Letters and digits only: every Markdown marker the model is allowed to add
 * — `#`, `-`, `>`, `*`, `|` — is punctuation, so comparing words compares the
 * text and ignores the layout, which is exactly the distinction the feature
 * rests on. Case is folded because capitalising a line promoted to a heading is
 * a layout change, not an edit. */
const WORD = /[\p{L}\p{N}]+/gu;

export function words(markdown: string): string[] {
  return markdown.toLowerCase().match(WORD) ?? [];
}

export interface WordDrift {
  /** Words of the source that are not in the result. Must be zero. */
  removed: number;
  /** Words in the result the source did not have. A heading's worth is fine. */
  added: number;
  /** Words the source had, for scaling the budget below. */
  source: number;
}

/**
 * How the words moved between two pieces of Markdown, as multisets.
 *
 * Order is deliberately not checked. Comparing sequences would need an edit
 * distance over documents that run to tens of thousands of words, and the thing
 * worth catching — text quietly rewritten, dropped, or invented — shows up in
 * the counts. Reordering without changing the words is the one abuse this
 * misses, and the prompt forbidding it plus a per-block scope makes it a
 * theoretical one.
 */
export function wordDrift(before: string, after: string): WordDrift {
  const remaining = new Map<string, number>();
  const source = words(before);
  for (const word of source) remaining.set(word, (remaining.get(word) ?? 0) + 1);

  let added = 0;
  for (const word of words(after)) {
    const count = remaining.get(word) ?? 0;
    if (count > 0) remaining.set(word, count - 1);
    else added += 1;
  }

  let removed = 0;
  for (const count of remaining.values()) removed += count;
  return { removed, added, source: source.length };
}

/** A heading, and not much of one. Both the floor for a short block and the
 * whole budget for an inserted one. */
const MIN_ADDED_WORDS = 12;

/** Long blocks are the ones that genuinely want two or three headings inside
 * them, so the allowance grows with the block — but as a fraction, so it can
 * never fund a rewritten paragraph. */
function addedBudget(sourceWords: number): number {
  return Math.max(MIN_ADDED_WORDS, Math.ceil(sourceWords * 0.05));
}

function isHeading(node: DocNode): boolean {
  return node.type === 'heading';
}

/**
 * Whether one edit is a layout change and nothing more.
 *
 * `remove` never is: a formatting pass that deletes a paragraph has deleted
 * part of the document. An `insert` is new text by definition, so it is allowed
 * only as a heading, and only a short one.
 */
export function preservesText(
  edit: RewriteProposal['blocks'][number],
  sourceBlock: string,
): boolean {
  if (edit.action === 'remove') return false;

  const nodes = proposalNodes(edit.node);
  if (!nodes.length) return false;
  if (edit.action === 'insert' && !nodes.every(isHeading)) return false;

  const before = edit.action === 'insert' ? '' : sourceBlock;
  const drift = wordDrift(before, docToMarkdown({ type: 'doc', content: nodes }));
  return drift.removed === 0 && drift.added <= addedBudget(drift.source);
}

export interface ReformatRequest {
  provider: ResolvedProvider;
  /** The converted document, exactly as AnyDoc produced it. */
  markdown: string;
}

export interface ReformatResult {
  markdown: string;
  /** Layout edits that survived the check and were applied. */
  applied: number;
  /** Edits that changed the text and were dropped. */
  rejected: number;
  summary?: string;
}

export async function requestReformat(
  request: ReformatRequest,
  options: AiRunOptions = {},
): Promise<ReformatResult> {
  const doc = markdownToDoc(request.markdown);
  const before = docToBlocks(doc);
  if (!before.some((block) => block.trim())) {
    throw new Error('there is nothing in this document to format');
  }

  const text = await runAi(
    {
      provider: request.provider,
      messages: reformatPrompt({ blocks: before }),
      // Larger than Rewrite's ceiling because the useful edit here is "this
      // wall of text, with headings in it", which re-emits the block. A
      // converted document is long and mostly walls of text.
      maxTokens: 16_000,
      // Layout is not a creative act, and a model improvising here is a model
      // whose edits this file is about to throw away.
      temperature: 0,
      json: true,
      stream: false,
    },
    options,
  );

  const response = parseModelJson(AiRewriteResponseSchema, text);
  const proposal = proposalFromResponse(response, before.length);

  const accepted = new Set<number>();
  // `applyProposal` takes the first `replace` it finds for a block and ignores
  // the rest, so a second one is not an edit that was applied. Dropping it here
  // keeps the count the dialog reports equal to the work that happened.
  const replaced = new Set<number>();
  let rejected = 0;
  for (const [position, edit] of proposal.blocks.entries()) {
    if (edit.action === 'replace' && replaced.has(edit.index)) continue;
    if (preservesText(edit, before[edit.index] ?? '')) {
      accepted.add(position);
      if (edit.action === 'replace') replaced.add(edit.index);
    } else rejected += 1;
  }

  // Nothing survived, so nothing happened: hand back the document untouched
  // rather than a round trip through the converter, which is lossy in its own
  // small ways and has no business running when there is no edit to apply.
  if (!accepted.size) {
    return { markdown: request.markdown, applied: 0, rejected };
  }

  const formatted = docToMarkdown(applyProposal(doc, proposal, accepted));

  // The per-edit check is the guarantee; this is the assertion that the
  // splicing kept it. It compares against the re-serialised original rather
  // than `request.markdown` so a lossy round trip is not reported as the model
  // losing text.
  if (wordDrift(docToMarkdown(doc), formatted).removed > 0) {
    throw new Error('reformatting would have dropped text from the document');
  }

  return {
    markdown: formatted,
    applied: accepted.size,
    rejected,
    summary: response.summary,
  };
}
