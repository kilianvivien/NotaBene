/**
 * Ask a model to review a course's vocabulary.
 *
 * The request carries words and one short excerpt per word, plus whatever
 * course material the student pasted — never the notes themselves. Everything
 * that comes back is a proposal; `vocabularyCommands.ts` writes only what the
 * student ticks.
 */
import { AiVocabularyResponseSchema, type AiVocabularyResponse } from '@/lib/schema';
import type { AiRunOptions } from './client';
import { vocabularyPrompt } from './prompts';
import type { ResolvedProvider } from './protocols';
import { runStructured } from './structured';

/** Enough words to show the model what the course is about and to catch the
 * misspellings that recur; past this the list is the long tail. */
export const MAX_VOCABULARY_CANDIDATES = 150;
/** A syllabus or a reading list, not a textbook. */
export const MAX_VOCABULARY_MATERIAL_CHARS = 12_000;
export const VOCABULARY_CONTEXT_CHARS = 120;

export interface VocabularyReviewRequest {
  provider: ResolvedProvider;
  courseName: string;
  candidates: { term: string; count: number; context: string }[];
  material: string;
  language: string;
}

export async function requestVocabularyReview(
  request: VocabularyReviewRequest,
  options: AiRunOptions = {},
): Promise<AiVocabularyResponse> {
  return runStructured(
    {
      provider: request.provider,
      messages: vocabularyPrompt({
        courseName: request.courseName,
        candidates: request.candidates.slice(0, MAX_VOCABULARY_CANDIDATES),
        material: request.material.slice(0, MAX_VOCABULARY_MATERIAL_CHARS),
        language: request.language,
      }),
      maxTokens: 3_000,
      // Spelling is not a creative act, and a second run on the same course
      // should not propose a different set of fixes.
      temperature: 0.1,
    },
    AiVocabularyResponseSchema,
    options,
  );
}

/**
 * A short excerpt around the first use of `term` in `text`, cut on word
 * boundaries — what the model needs to tell a typo from a technical term.
 */
export function excerptAround(
  text: string,
  term: string,
  limit = VOCABULARY_CONTEXT_CHARS,
): string {
  const at = text.indexOf(term);
  if (at < 0) return '';
  const half = Math.max(0, Math.floor((limit - term.length) / 2));
  let start = Math.max(0, at - half);
  let end = Math.min(text.length, at + term.length + half);
  const space = text.lastIndexOf(' ', at);
  if (start > 0 && space > start) start = space + 1;
  const next = text.indexOf(' ', at + term.length);
  if (end < text.length && next > 0 && next < end) end = next;
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}
