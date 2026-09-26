/**
 * Check one paragraph, on request.
 *
 * What comes back is located in the paragraph before anyone sees it: a
 * correction whose `original` does not occur verbatim is dropped here, because
 * the dialog can only offer a change it can point at, and a model that
 * paraphrased the span it meant to fix has not told us where the fix goes.
 */
import { AiProofreadResponseSchema } from '@/lib/schema';
import type { AiRunOptions } from './client';
import { proofreadPrompt } from './prompts';
import type { ResolvedProvider } from './protocols';
import { runStructured } from './structured';

/** A long paragraph, not a chapter. The command refuses more. */
export const MAX_PROOFREAD_CHARS = 4_000;
/** Course terms sent along so they are not "corrected". */
export const MAX_PROOFREAD_VOCABULARY = 300;

export interface ProofreadCorrection {
  original: string;
  replacement: string;
  reason?: string;
  /** Offset of `original` in the paragraph, in UTF-16 code units. */
  index: number;
}

export interface ProofreadRequest {
  provider: ResolvedProvider;
  paragraph: string;
  vocabulary: string[];
  language: string;
}

export async function requestProofread(
  request: ProofreadRequest,
  options: AiRunOptions = {},
): Promise<ProofreadCorrection[]> {
  const response = await runStructured(
    {
      provider: request.provider,
      messages: proofreadPrompt({
        paragraph: request.paragraph,
        vocabulary: request.vocabulary.slice(0, MAX_PROOFREAD_VOCABULARY),
        language: request.language,
      }),
      maxTokens: 1_500,
      temperature: 0,
    },
    AiProofreadResponseSchema,
    options,
  );
  return locateCorrections(request.paragraph, response.corrections);
}

/**
 * Pin each correction to a place in the paragraph.
 *
 * Searches from the end of the previous match, so two corrections of the same
 * word land on its first and second occurrence rather than both on the first.
 * Overlapping corrections are dropped: applying both would edit text the
 * other one had already replaced.
 */
export function locateCorrections(
  paragraph: string,
  corrections: readonly { original: string; replacement: string; reason?: string }[],
): ProofreadCorrection[] {
  const located: ProofreadCorrection[] = [];
  const cursor = new Map<string, number>();
  for (const correction of corrections) {
    if (correction.original === correction.replacement) continue;
    // A span across an inline node (a link chip, an equation) cannot be
    // rewritten as text.
    if (correction.original.includes('\ufffc')) continue;
    const from = cursor.get(correction.original) ?? 0;
    const index = paragraph.indexOf(correction.original, from);
    if (index < 0) continue;
    cursor.set(correction.original, index + correction.original.length);
    const end = index + correction.original.length;
    const overlaps = located.some(
      (other) => index < other.index + other.original.length && other.index < end,
    );
    if (overlaps) continue;
    located.push({ ...correction, index });
  }
  return located.sort((a, b) => a.index - b.index);
}
