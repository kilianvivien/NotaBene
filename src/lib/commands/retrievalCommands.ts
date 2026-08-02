/**
 * Gathering the notes that answer a question.
 *
 * The I/O half of retrieval: the ranking and packing are pure and live in
 * `src/lib/ai/retrieval.ts`. Read-only — this command writes nothing, and sits
 * beside `readCommands.ts` for the same reason those do, so nothing reaches
 * past the command layer to an adapter.
 *
 * Scope `note` short-circuits before any search runs. That is not an
 * optimisation: it is the guarantee that opening the Ask panel on a note
 * behaves exactly as it did before retrieval existed.
 */
import { library } from '@/lib/adapters';
import {
  fuseCandidates,
  packSources,
  sourceBudget,
  MAX_SOURCES,
  type AskScope,
  type Candidate,
  type RetrievalResult,
  type RetrievedSource,
} from '@/lib/ai/retrieval';
import type { DocNode, Note, NoteDoc } from '@/lib/schema';
import { deriveTurnKeywords } from '@/lib/search/keywords';
import { queryNotesCommand, rankNotesCommand, readNoteCommand } from './readCommands';
import { fail, ok, type CommandResult } from './types';

export interface AskSourcesInput {
  /** The open note. Always included, always first. */
  anchorNoteId: string;
  scope: AskScope;
  question: string;
  /** Earlier questions in this thread, oldest first. Feeds carry-forward. */
  priorQuestions?: string[];
  /** Everything else already destined for the prompt, for budgeting. */
  spokenContext?: string;
}

/** How many ranked candidates to consider before fusing and packing. */
const CANDIDATE_LIMIT = 40;

export async function gatherAskSourcesCommand(
  input: AskSourcesInput,
): Promise<CommandResult<RetrievalResult>> {
  const anchorResult = await readNoteCommand(input.anchorNoteId);
  if (!anchorResult.ok) return anchorResult;
  const anchor = anchorResult.value;

  if (input.scope === 'note') {
    return ok({
      sources: [
        {
          noteId: anchor.id,
          title: anchor.title,
          courseId: anchor.courseId,
          doc: anchor.doc,
          reason: 'anchor',
          truncated: false,
        } satisfies RetrievedSource,
      ],
      keywords: [],
      droppedCount: 0,
    });
  }

  const courseId = input.scope === 'course' ? anchor.courseId : undefined;
  const keywords = deriveTurnKeywords(input.question, input.priorQuestions ?? []);
  const budget = sourceBudget(
    `${input.spokenContext ?? ''}\n${(input.priorQuestions ?? []).join('\n')}\n${input.question}`,
  );

  const candidates = keywords.length
    ? await searchCandidates(keywords, courseId)
    : await recentCandidates(courseId);
  if (!candidates.ok) return candidates;

  const linked = await linkedCandidates(anchor);
  if (!linked.ok) return linked;
  const merged = mergeCandidates(candidates.value, linked.value);

  // Only fetch documents for notes that could plausibly survive packing —
  // `getNote` is the expensive call in this path.
  const fused = fuseCandidates(merged, anchor.id).slice(0, MAX_SOURCES + 4);
  const withDocs: { candidate: Candidate; doc: NoteDoc }[] = [];
  for (const candidate of fused) {
    const note = await library.getNote(candidate.noteId);
    if (note) withDocs.push({ candidate, doc: note.doc });
  }

  const packed = packSources(
    {
      noteId: anchor.id,
      title: anchor.title,
      courseId: anchor.courseId,
      doc: anchor.doc,
    },
    withDocs,
    keywords,
    budget,
  );

  return ok({ ...packed, keywords });
}

async function searchCandidates(
  keywords: string[],
  courseId: string | null | undefined,
): Promise<CommandResult<Candidate[]>> {
  const result = await rankNotesCommand({
    text: keywords.join(' '),
    textMatch: 'any',
    scope: 'live',
    sort: 'relevance',
    ...(courseId === undefined ? {} : { courseId }),
    limit: CANDIDATE_LIMIT,
  });
  if (!result.ok) return result;
  return ok(
    result.value.map((match) => ({
      noteId: match.note.id,
      title: match.note.title,
      courseId: match.note.courseId,
      updatedAt: match.note.updatedAt,
      score: match.score,
      linked: false,
    })),
  );
}

/**
 * What to look at when the question has no content words to search on — "why?"
 * on its own, in a thread with nothing to carry forward. Recency is a weak
 * signal, but it beats answering from the open note alone while claiming to
 * have looked wider.
 */
async function recentCandidates(
  courseId: string | null | undefined,
): Promise<CommandResult<Candidate[]>> {
  const result = await queryNotesCommand({
    scope: 'live',
    sort: 'updated',
    ...(courseId === undefined ? {} : { courseId }),
    limit: MAX_SOURCES,
  });
  if (!result.ok) return result;
  return ok(
    result.value.map((note) => ({
      noteId: note.id,
      title: note.title,
      courseId: note.courseId,
      updatedAt: note.updatedAt,
      score: 0,
      linked: false,
    })),
  );
}

/**
 * Notes the student has already connected to this one, in either direction.
 * A wiki link is a topical judgement they made themselves, which is a better
 * signal than anything a keyword match can offer — and it is already indexed.
 */
async function linkedCandidates(anchor: Note): Promise<CommandResult<Candidate[]>> {
  try {
    const backlinks = await library.listBacklinks(anchor.id);
    const found = new Map<string, Candidate>();

    for (const backlink of backlinks) {
      found.set(backlink.sourceId, {
        noteId: backlink.sourceId,
        title: backlink.sourceTitle,
        courseId: null,
        updatedAt: backlink.updatedAt,
        score: 0,
        linked: true,
      });
    }

    // Outgoing links are in the document itself — no adapter call needed.
    for (const noteId of outgoingLinkIds(anchor.doc)) {
      if (noteId === anchor.id || found.has(noteId)) continue;
      const note = await library.getNote(noteId);
      if (!note || note.archived || note.trashedAt) continue;
      found.set(noteId, {
        noteId,
        title: note.title,
        courseId: note.courseId,
        updatedAt: note.updatedAt,
        score: 0,
        linked: true,
      });
    }

    return ok([...found.values()]);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

function outgoingLinkIds(doc: NoteDoc): string[] {
  const ids: string[] = [];
  const visit = (node: DocNode) => {
    if (node.type === 'wikiLink' && typeof node.attrs?.noteId === 'string') {
      ids.push(node.attrs.noteId);
    }
    node.content?.forEach(visit);
  };
  doc.content.forEach(visit);
  return ids;
}

/** Search results win on identity; a note found both ways keeps its score and
 * gains the link flag. */
function mergeCandidates(searched: Candidate[], linked: Candidate[]): Candidate[] {
  const byId = new Map(searched.map((candidate) => [candidate.noteId, candidate]));
  for (const candidate of linked) {
    const existing = byId.get(candidate.noteId);
    if (existing) byId.set(candidate.noteId, { ...existing, linked: true });
    else byId.set(candidate.noteId, candidate);
  }
  return [...byId.values()];
}
