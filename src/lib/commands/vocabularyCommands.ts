/**
 * A course's vocabulary: the words it completes, and the words it must not.
 *
 * The only path that writes `course_terms`, for the reason every other
 * mutation has a command: the dialog, the editor's "add this word", and an
 * accepted AI review all reach the store the same way, with the same
 * validation and the same cache invalidation.
 *
 * Two AI calls live here too, and neither writes. `proposeVocabularyCommand`
 * asks a model to review the course's words and returns proposals;
 * `proofreadCommand` asks about one paragraph and returns corrections the
 * editor applies itself, so they autosave, undo and version like typing.
 * What the student accepts from a vocabulary review is written by
 * `applyVocabularyReviewCommand`, with `source: 'ai'` on every row.
 */
import { z } from 'zod';
import { library, type Abbreviation } from '@/lib/adapters';
import {
  MAX_PROOFREAD_CHARS,
  excerptAround,
  requestProofread,
  requestVocabularyReview,
  MAX_VOCABULARY_CANDIDATES,
  MAX_VOCABULARY_MATERIAL_CHARS,
  type AiRunOptions,
  type ProofreadCorrection,
} from '@/lib/ai';
import {
  CourseTermStatusSchema,
  MAX_COURSE_TERM_LENGTH,
  newId,
  type AiVocabularyResponse,
  type CourseTerm,
  type CourseTermStatus,
} from '@/lib/schema';
import {
  createAbbreviation,
  MAX_ABBREVIATIONS,
  MAX_TRIGGER_LENGTH,
  normalizeAbbreviations,
} from '@/lib/notes/abbreviations';
import { useSettingsStore } from '@/lib/state/settingsStore';
import {
  foldKey,
  invalidateVocabulary,
  loadCourseVocabulary,
  normalizeTerm,
} from '@/lib/vocabulary';
import { aiFailure, language, providerFor } from './aiCommands';
import { fail, ok, USER, type CommandContext, type CommandResult } from './types';

/** A term must contain a letter, and cannot span lines: a pasted sentence is
 * not vocabulary. */
const TermText = z
  .string()
  .transform(normalizeTerm)
  .pipe(
    z
      .string()
      .min(1)
      .max(MAX_COURSE_TERM_LENGTH)
      .regex(/\p{L}/u, 'a term needs at least one letter'),
  );

const SetTermInput = z.object({
  courseId: z.string().min(1),
  term: TermText,
  status: CourseTermStatusSchema.default('accepted'),
});
export type SetCourseTermInput = z.input<typeof SetTermInput>;

function sourceOf(context: CommandContext): CourseTerm['source'] {
  return context.source === 'user' ? 'user' : 'ai';
}

async function requireCourse(courseId: string): Promise<boolean> {
  return (await library.listCourses()).some((course) => course.id === courseId);
}

/**
 * Write one term against what the course already has. Folded matching, so
 * "Schrodinger" and "Schrödinger" are one row: the new spelling and status
 * replace the old under the same id.
 */
async function writeTerm(
  existing: CourseTerm[],
  courseId: string,
  term: string,
  status: CourseTermStatus,
  context: CommandContext,
): Promise<CourseTerm> {
  const key = foldKey(term);
  const match = existing.find((entry) => foldKey(entry.term) === key);
  if (match && match.term === term && match.status === status) return match;
  const row: CourseTerm = {
    id: match?.id ?? newId(),
    courseId,
    term,
    status,
    source: sourceOf(context),
    createdAt: match?.createdAt ?? new Date().toISOString(),
  };
  await library.upsertCourseTerm(row);
  if (match) Object.assign(match, row);
  else existing.push(row);
  return row;
}

/** Add a word to a course's vocabulary, or tell it never to suggest one. */
export async function setCourseTermCommand(
  input: SetCourseTermInput,
  context: CommandContext = USER,
): Promise<CommandResult<CourseTerm>> {
  const parsed = SetTermInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'not a usable term', parsed.error.issues);
  }
  const { courseId, term, status } = parsed.data;
  try {
    if (!(await requireCourse(courseId))) return fail('not_found', 'course not found');
    const existing = await library.listCourseTerms(courseId);
    const row = await writeTerm(existing, courseId, term, status, context);
    invalidateVocabulary(courseId);
    return ok(row);
  } catch (error) {
    return fail('storage_failed', 'could not save the term', error);
  }
}

export async function removeCourseTermCommand(
  termId: string,
): Promise<CommandResult<void>> {
  try {
    const term = (await library.listCourseTerms(null)).find(
      (entry) => entry.id === termId,
    );
    if (!term) return fail('not_found', 'term not found');
    await library.deleteCourseTerm(termId);
    invalidateVocabulary(term.courseId);
    return ok(undefined);
  } catch (error) {
    return fail('storage_failed', 'could not remove the term', error);
  }
}

// ---------------------------------------------------------------------------
// AI review
// ---------------------------------------------------------------------------

export interface VocabularyProposal {
  corrections: { from: string; to: string; reason?: string }[];
  terms: string[];
  acronyms: { acronym: string; expansion: string }[];
}

/**
 * Drop what the student could not usefully accept: a "correction" to the
 * same spelling, a term the course already has, an acronym that is already
 * an abbreviation trigger, and duplicates the model repeated.
 */
export function filterVocabularyProposal(
  response: AiVocabularyResponse,
  curated: readonly CourseTerm[],
  abbreviations: readonly Abbreviation[],
): VocabularyProposal {
  const accepted = new Set(
    curated
      .filter((entry) => entry.status === 'accepted')
      .map((entry) => foldKey(entry.term)),
  );
  const seenCorrections = new Set<string>();
  const corrections = response.corrections
    .map((entry) => ({
      ...entry,
      from: normalizeTerm(entry.from),
      to: normalizeTerm(entry.to),
    }))
    .filter((entry) => {
      if (entry.from === entry.to || !/\p{L}/u.test(entry.to)) return false;
      if (seenCorrections.has(entry.from)) return false;
      seenCorrections.add(entry.from);
      return true;
    });

  const seenTerms = new Set<string>();
  const terms = response.terms
    .map((entry) => normalizeTerm(entry.term))
    .filter((term) => {
      const key = foldKey(term);
      if (!/\p{L}/u.test(term) || accepted.has(key) || seenTerms.has(key)) return false;
      seenTerms.add(key);
      return true;
    });

  const triggers = new Set(abbreviations.map((rule) => rule.trigger.toLowerCase()));
  const acronyms = response.acronyms
    .map((entry) => ({
      acronym: entry.acronym.trim(),
      expansion: normalizeTerm(entry.expansion),
    }))
    .filter((entry) => {
      const key = entry.acronym.toLowerCase();
      const usable =
        !/\s/.test(entry.acronym) &&
        entry.acronym.length <= MAX_TRIGGER_LENGTH &&
        entry.expansion.length > entry.acronym.length &&
        !triggers.has(key);
      if (usable) triggers.add(key);
      return usable;
    });

  return { corrections, terms, acronyms };
}

const ProposeInput = z.object({
  courseId: z.string().min(1),
  /** A syllabus, a reading list — pasted by the student, optional. */
  material: z
    .string()
    .max(MAX_VOCABULARY_MATERIAL_CHARS * 2)
    .default(''),
});

/** Ask a model to review a course's words. A read: nothing is written. */
export async function proposeVocabularyCommand(
  input: z.input<typeof ProposeInput>,
  options: AiRunOptions = {},
): Promise<CommandResult<VocabularyProposal>> {
  const parsed = ProposeInput.safeParse(input);
  if (!parsed.success)
    return fail('invalid_input', 'invalid request', parsed.error.issues);
  const { courseId, material } = parsed.data;

  const course = (await library.listCourses()).find((entry) => entry.id === courseId);
  if (!course) return fail('not_found', 'course not found');

  const lookup = await providerFor('vocabulary');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    const [{ harvested, curated }, texts] = await Promise.all([
      loadCourseVocabulary(courseId),
      library.listNoteTexts(courseId),
    ]);
    const decided = new Set(curated.map((entry) => foldKey(entry.term)));
    const candidates = harvested
      .filter((entry) => !decided.has(entry.key))
      .slice(0, MAX_VOCABULARY_CANDIDATES)
      .map((entry) => {
        let context = '';
        for (const text of texts) {
          context = excerptAround(text.plainText, entry.term);
          if (context) break;
        }
        return { term: entry.term, count: entry.count, context };
      });
    if (!candidates.length && !material.trim()) {
      return fail('invalid_input', 'nothing to review yet');
    }

    const response = await requestVocabularyReview(
      {
        provider: lookup.provider,
        courseName: course.name,
        candidates,
        material,
        language: language(),
      },
      options,
    );
    return ok(
      filterVocabularyProposal(
        response,
        curated,
        useSettingsStore.getState().settings.abbreviations,
      ),
    );
  } catch (error) {
    return aiFailure(error, options.signal);
  }
}

export interface VocabularyReviewChoices {
  corrections: { from: string; to: string }[];
  terms: string[];
  acronyms: { acronym: string; expansion: string }[];
}

/**
 * Write what the student ticked from a review.
 *
 * A correction accepts the right spelling and, when the wrong one is a
 * different word rather than the same word without its accents, rejects the
 * wrong one — otherwise the harvest would go on offering the typo the notes
 * still contain. Acronyms become abbreviations, in settings, where the
 * student can see and edit them with the rest.
 */
export async function applyVocabularyReviewCommand(
  courseId: string,
  choices: VocabularyReviewChoices,
  context: CommandContext = { source: 'ai' },
): Promise<CommandResult<{ terms: number; abbreviations: number }>> {
  try {
    if (!(await requireCourse(courseId))) return fail('not_found', 'course not found');
    const existing = await library.listCourseTerms(courseId);
    let written = 0;

    for (const correction of choices.corrections) {
      const from = normalizeTerm(correction.from);
      const to = normalizeTerm(correction.to);
      if (!to || to.length > MAX_COURSE_TERM_LENGTH) continue;
      if (
        from &&
        foldKey(from) !== foldKey(to) &&
        from.length <= MAX_COURSE_TERM_LENGTH
      ) {
        await writeTerm(existing, courseId, from, 'rejected', context);
        written += 1;
      }
      await writeTerm(existing, courseId, to, 'accepted', context);
      written += 1;
    }
    for (const raw of choices.terms) {
      const term = normalizeTerm(raw);
      if (!term || term.length > MAX_COURSE_TERM_LENGTH || !/\p{L}/u.test(term)) continue;
      await writeTerm(existing, courseId, term, 'accepted', context);
      written += 1;
    }

    let added = 0;
    if (choices.acronyms.length) {
      const settings = useSettingsStore.getState();
      const current = settings.settings.abbreviations;
      const triggers = new Set(current.map((rule) => rule.trigger.toLowerCase()));
      const next = [...current];
      for (const { acronym, expansion } of choices.acronyms) {
        if (next.length >= MAX_ABBREVIATIONS) break;
        const trigger = acronym.trim();
        if (!trigger || triggers.has(trigger.toLowerCase())) continue;
        triggers.add(trigger.toLowerCase());
        next.push(createAbbreviation(trigger, expansion));
        added += 1;
      }
      if (added) await settings.update({ abbreviations: normalizeAbbreviations(next) });
    }

    invalidateVocabulary(courseId);
    return ok({ terms: written, abbreviations: added });
  } catch (error) {
    return fail('storage_failed', 'could not save the vocabulary', error);
  }
}

// ---------------------------------------------------------------------------
// Proofread
// ---------------------------------------------------------------------------

const ProofreadInput = z.object({
  paragraph: z.string().min(1).max(MAX_PROOFREAD_CHARS),
  courseId: z.string().nullable().default(null),
});

/**
 * Check one paragraph. A read, like `defineTermCommand`: the corrections come
 * back to the editor, which applies the ones the student accepts.
 */
export async function proofreadCommand(
  input: z.input<typeof ProofreadInput>,
  options: AiRunOptions = {},
): Promise<CommandResult<ProofreadCorrection[]>> {
  if ((input.paragraph ?? '').length > MAX_PROOFREAD_CHARS) {
    // The limit travels in `details` so the dialog can say it in the
    // student's language.
    return fail('invalid_input', 'that paragraph is too long to check', {
      reason: 'too_long',
      limit: MAX_PROOFREAD_CHARS,
    });
  }
  const parsed = ProofreadInput.safeParse(input);
  if (!parsed.success)
    return fail('invalid_input', 'nothing to check', parsed.error.issues);
  if (!parsed.data.paragraph.trim()) return fail('invalid_input', 'nothing to check');

  const lookup = await providerFor('proofread');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    const curated = parsed.data.courseId
      ? await library.listCourseTerms(parsed.data.courseId)
      : [];
    const vocabulary = curated
      .filter((entry) => entry.status === 'accepted')
      .map((entry) => entry.term);
    return ok(
      await requestProofread(
        {
          provider: lookup.provider,
          paragraph: parsed.data.paragraph,
          vocabulary,
          language: language(),
        },
        options,
      ),
    );
  } catch (error) {
    return aiFailure(error, options.signal);
  }
}
