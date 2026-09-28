/**
 * The staged changeset of an agent run (plan §3.2 item 8), as data.
 *
 * Pure: which calls stage, how a call splits into what must happen now and
 * what can wait, and what a changeset amounts to in the terms the student
 * reviews it in. Executing and applying live in `agentCommands.ts`.
 */
import type { AgentChangeset, AgentPlan, AgentToolName } from '@/lib/schema';

/** Metadata writes: cheap to hold back, and the ones a run makes in bulk.
 * Body edits keep whole-run undo as their safety net instead — staging a diff
 * of every body is the hard problem §3 declined. */
export const STAGEABLE_TOOLS = new Set<AgentToolName>([
  'organize',
  'manage_tags',
  'archive_notes',
  'trash_notes',
]);

/** Above this many notes a changeset waits for Apply; at or below it, it is
 * applied as the run finishes. */
export const CHANGESET_REVIEW_THRESHOLD = 10;

export type StagedCall = AgentChangeset['calls'][number];

/** Whether a run records its metadata writes rather than making them. Decided
 * from the approved plan, so the whole run behaves one way. */
export function planStagesChanges(plan: AgentPlan): boolean {
  return plan.steps.some((step) =>
    step.expectedTools.some((tool) => STAGEABLE_TOOLS.has(tool)),
  );
}

export interface StagingSplit {
  /** Run immediately, because a later call needs its result. */
  now: Record<string, unknown> | null;
  /** Record for review. */
  staged: Record<string, unknown> | null;
}

/**
 * What of a call can wait.
 *
 * A new section is created at once — the moves that follow need its id, and
 * an empty section is undone like any other. A tag rename is global rather
 * than a change to these notes, so it is not staged either. The single-note
 * `manage_tags` form is rewritten into the list form, so every staged call
 * names its notes the same way.
 */
export function splitForStaging(
  tool: AgentToolName,
  args: Record<string, unknown>,
): StagingSplit {
  if (!STAGEABLE_TOOLS.has(tool)) return { now: args, staged: null };
  if (tool === 'manage_tags') {
    if (Array.isArray(args.rename) && args.rename.length > 0) {
      return { now: args, staged: null };
    }
    if (!Array.isArray(args.notes) && typeof args.noteId === 'string') {
      const { noteId, baseUpdatedAt, ...rest } = args;
      return { now: null, staged: { ...rest, notes: [{ noteId, baseUpdatedAt }] } };
    }
  }
  if (tool === 'organize') {
    const moves = Array.isArray(args.moves) ? args.moves : [];
    return {
      now: args.createSection ? { createSection: args.createSection } : null,
      staged: moves.length ? { moves } : null,
    };
  }
  return { now: null, staged: args };
}

export interface VersionedRef {
  noteId: string;
  baseUpdatedAt: string;
}

/** The notes a staged call writes, each with the version it was read at.
 * Returned by reference, so applying can refresh a version in place. */
export function stagedRefs(call: Pick<StagedCall, 'tool' | 'arguments'>): VersionedRef[] {
  const list = call.tool === 'organize' ? call.arguments.moves : call.arguments.notes;
  return Array.isArray(list)
    ? list.filter(
        (entry): entry is VersionedRef =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as VersionedRef).noteId === 'string' &&
          typeof (entry as VersionedRef).baseUpdatedAt === 'string',
      )
    : [];
}

/** Drop some notes from a staged call, keeping the rest of its arguments. */
export function withoutNotes(
  call: Pick<StagedCall, 'tool' | 'arguments'>,
  noteIds: ReadonlySet<string>,
): Record<string, unknown> {
  const key = call.tool === 'organize' ? 'moves' : 'notes';
  const list = call.arguments[key];
  return {
    ...call.arguments,
    [key]: Array.isArray(list)
      ? list.filter(
          (entry) =>
            !(
              typeof entry === 'object' &&
              entry !== null &&
              noteIds.has((entry as VersionedRef).noteId)
            ),
        )
      : list,
  };
}

export function changesetNoteIds(calls: readonly StagedCall[]): string[] {
  return [...new Set(calls.flatMap((call) => stagedRefs(call).map((ref) => ref.noteId)))];
}

export interface ChangesetSummary {
  notes: number;
  moves: { courseId: string | null; sectionId: string | null; count: number }[];
  tagsAdded: { name: string; count: number }[];
  tagsRemoved: { tagId: string; count: number }[];
  archived: number;
  unarchived: number;
  trashed: number;
}

/**
 * What the changeset does, grouped the way it is reviewed — *23 notes →
 * Constitutional Law / Week 4, 6 archived* — with each count in distinct
 * notes, so a note tagged twice by two calls is one note.
 */
export function summarizeChangeset(calls: readonly StagedCall[]): ChangesetSummary {
  const moves = new Map<string, { courseId: string | null; sectionId: string | null; notes: Set<string> }>();
  const added = new Map<string, Set<string>>();
  const removed = new Map<string, Set<string>>();
  const archived = new Set<string>();
  const unarchived = new Set<string>();
  const trashed = new Set<string>();
  const into = <K>(map: Map<K, Set<string>>, key: K, noteId: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(noteId);
    map.set(key, set);
  };

  for (const call of calls) {
    const refs = stagedRefs(call);
    if (call.tool === 'organize') {
      for (const move of refs as (VersionedRef & {
        courseId?: string | null;
        sectionId?: string | null;
      })[]) {
        const courseId = move.courseId ?? null;
        const sectionId = move.sectionId ?? null;
        const key = `${courseId}/${sectionId}`;
        const entry = moves.get(key) ?? { courseId, sectionId, notes: new Set<string>() };
        entry.notes.add(move.noteId);
        moves.set(key, entry);
      }
    } else if (call.tool === 'manage_tags') {
      const add = stringList(call.arguments.add);
      const remove = stringList(call.arguments.remove);
      for (const ref of refs) {
        add.forEach((name) => into(added, name, ref.noteId));
        remove.forEach((tagId) => into(removed, tagId, ref.noteId));
      }
    } else if (call.tool === 'archive_notes') {
      const target = call.arguments.archived === false ? unarchived : archived;
      refs.forEach((ref) => target.add(ref.noteId));
    } else if (call.tool === 'trash_notes') {
      refs.forEach((ref) => trashed.add(ref.noteId));
    }
  }

  return {
    notes: changesetNoteIds(calls).length,
    moves: [...moves.values()]
      .map(({ courseId, sectionId, notes }) => ({ courseId, sectionId, count: notes.size }))
      .sort((a, b) => b.count - a.count),
    tagsAdded: [...added].map(([name, notes]) => ({ name, count: notes.size })),
    tagsRemoved: [...removed].map(([tagId, notes]) => ({ tagId, count: notes.size })),
    archived: archived.size,
    unarchived: unarchived.size,
    trashed: trashed.size,
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
