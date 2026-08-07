/**
 * Rewrite & correct.
 *
 * The note goes to the model as numbered Markdown blocks and comes back as a
 * list of per-block edits. Nothing is written: the result is a
 * `RewriteProposal` the diff panel renders, and only the blocks the user ticks
 * ever reach `updateNoteCommand`.
 *
 * Markdown rather than ProseMirror JSON both ways. Models are fluent in the
 * first and improvise in the second, and the app already owns a loss-aware
 * converter for exactly this document vocabulary.
 */
import { docToMarkdown, markdownToDoc } from '@/editor/markdown';
import {
  AiRewriteResponseSchema,
  type AiRewriteResponse,
  type DocNode,
  type NoteDoc,
  type RewriteProposal,
} from '@/lib/schema';
import { runAi, type AiRunOptions } from './client';
import { parseModelJson } from './json';
import { rewritePrompt, type RewriteMode } from './prompts';
import type { ResolvedProvider } from './protocols';

/** One top-level block, rendered in the dialect the prompt describes. */
export function blockToMarkdown(node: DocNode): string {
  return docToMarkdown({ type: 'doc', content: [node] }).trim();
}

export function docToBlocks(doc: NoteDoc): string[] {
  return doc.content.map(blockToMarkdown);
}

/** Markdown back to a single node. A model that answers a one-block edit with
 * three paragraphs gets all three — they are wrapped so the proposal stays one
 * entry per source block and the diff stays readable. */
function markdownToNode(markdown: string): DocNode | null {
  const parsed = markdownToDoc(markdown.trim());
  const [first, ...rest] = parsed.content;
  if (!first) return null;
  if (!rest.length) return first;
  // No block type wraps arbitrary siblings except the document itself, so keep
  // the extra nodes by handing the proposal a fragment the applier splices.
  return { type: 'nb-fragment', content: parsed.content };
}

/** Expand the fragment above at apply time. */
export function proposalNodes(node: DocNode | undefined): DocNode[] {
  if (!node) return [];
  return node.type === 'nb-fragment' ? (node.content ?? []) : [node];
}

/** The proposed text, for the "after" side of the diff. Goes through
 * `proposalNodes` so a multi-block replacement renders as what it is rather
 * than as an empty wrapper. */
export function proposalMarkdown(node: DocNode | undefined): string {
  return docToMarkdown({ type: 'doc', content: proposalNodes(node) }).trim();
}

/**
 * A model's block edits, read against the document it was shown.
 *
 * Shared with the import reformatter in `reformat.ts`, which asks for exactly
 * this answer shape for exactly this reason: an edit list is proportional to
 * what changed, and a converted lecture handout is far too long to ask a model
 * to type back out in full.
 */
export function proposalFromResponse(
  response: AiRewriteResponse,
  blockCount: number,
): RewriteProposal {
  return {
    blocks: response.blocks
      // An index past the end of the note is the model losing count. Dropping
      // the entry is right: the alternative is appending an edit somewhere the
      // user never saw a block, which is how a diff panel loses trust.
      .filter((block) => block.index < blockCount)
      .map((block) => ({
        index: block.index,
        action: block.action,
        node: block.markdown ? (markdownToNode(block.markdown) ?? undefined) : undefined,
        rationale: block.rationale,
      }))
      .filter((block) => block.action === 'remove' || block.node !== undefined),
  };
}

export interface RewriteRequest {
  provider: ResolvedProvider;
  doc: NoteDoc;
  mode: RewriteMode;
  instruction?: string;
  language: string;
}

export interface RewriteResult {
  proposal: RewriteProposal;
  summary?: string;
  /** The block Markdown the model was shown, so the diff can display the
   * "before" side without re-deriving it and risking a mismatch. */
  before: string[];
}

export async function requestRewrite(
  request: RewriteRequest,
  options: AiRunOptions = {},
): Promise<RewriteResult> {
  const before = docToBlocks(request.doc);
  if (!before.some((block) => block.trim())) {
    throw new Error('there is nothing in this note to rewrite');
  }

  const text = await runAi(
    {
      provider: request.provider,
      messages: rewritePrompt({
        mode: request.mode,
        instruction: request.instruction,
        blocks: before,
        language: request.language,
      }),
      maxTokens: 8_000,
      temperature: request.mode === 'light' ? 0 : 0.3,
      json: true,
      stream: false,
    },
    options,
  );

  const response = parseModelJson(AiRewriteResponseSchema, text);

  return {
    proposal: proposalFromResponse(response, before.length),
    summary: response.summary,
    before,
  };
}

/**
 * Apply the accepted subset of a proposal to a document.
 *
 * Pure, and indexed against the *original* document rather than a running
 * cursor: every entry's `index` refers to the note the model was shown, so
 * applying an insert must not shift the meaning of the edits after it. Building
 * the result block by block is what keeps rejecting the third change from
 * silently moving the fourth.
 */
export function applyProposal(
  doc: NoteDoc,
  proposal: RewriteProposal,
  accepted: ReadonlySet<number>,
): NoteDoc {
  const byIndex = new Map<number, RewriteProposal['blocks']>();
  for (const [position, block] of proposal.blocks.entries()) {
    if (!accepted.has(position)) continue;
    const bucket = byIndex.get(block.index) ?? [];
    bucket.push(block);
    byIndex.set(block.index, bucket);
  }

  const content: DocNode[] = [];
  for (const [index, node] of doc.content.entries()) {
    const edits = byIndex.get(index) ?? [];
    for (const edit of edits.filter((entry) => entry.action === 'insert')) {
      content.push(...proposalNodes(edit.node));
    }

    const replacement = edits.find((entry) => entry.action === 'replace');
    const removed = edits.some((entry) => entry.action === 'remove');
    if (replacement) content.push(...proposalNodes(replacement.node));
    else if (!removed) content.push(node);
  }

  // A note whose every block was removed still needs somewhere to put the
  // cursor; an empty `content` array is a document the editor cannot mount.
  return {
    type: 'doc',
    content: content.length ? content : [{ type: 'paragraph' }],
  };
}
