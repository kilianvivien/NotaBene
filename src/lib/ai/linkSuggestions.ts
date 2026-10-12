/**
 * Links a model proposes between notes.
 *
 * It writes nothing. The graph view shows each suggestion with its reason and
 * the student accepts or ignores it; only an accepted one becomes an edit,
 * through `acceptSuggestedLinkCommand`. That is the same guard every other AI
 * feature here is built on: parsed by a schema, approved by the student, then
 * a command.
 */
import { AiLinkSuggestionsResponseSchema } from '@/lib/schema';
import type { AiRunOptions } from './client';
import { linkSuggestionPrompt } from './prompts';
import type { ResolvedProvider } from './protocols';
import { runStructured } from './structured';

/** The most notes shown to the model at once. Past this the excerpts stop
 * fitting a small context window, and the model stops reading the far end. */
export const MAX_LINK_SUGGESTION_NOTES = 60;
/** The most suggestions kept. A list longer than this is not read. */
export const MAX_LINK_SUGGESTIONS = 12;
/** How much of each note the model sees. */
export const LINK_EXCERPT_CHARS = 360;

export interface LinkCandidateNote {
  id: string;
  title: string;
  course: string | null;
  excerpt: string;
}

export interface LinkSuggestion {
  sourceId: string;
  targetId: string;
  reason: string;
}

/** One suggestion's identity: which note would be written in, and to what. */
export function suggestionKey(link: Pick<LinkSuggestion, 'sourceId' | 'targetId'>): string {
  return `${link.sourceId}>${link.targetId}`;
}

export interface LinkSuggestionRequest {
  provider: ResolvedProvider;
  notes: LinkCandidateNote[];
  /** Pairs that are already linked, as `source>target`, in either order. */
  linked: Set<string>;
  language: string;
}

export async function requestLinkSuggestions(
  request: LinkSuggestionRequest,
  options: AiRunOptions = {},
): Promise<LinkSuggestion[]> {
  const response = await runStructured(
    {
      provider: request.provider,
      messages: linkSuggestionPrompt({
        notes: request.notes,
        max: MAX_LINK_SUGGESTIONS,
        language: request.language,
      }),
      maxTokens: 2_000,
      temperature: 0.2,
    },
    AiLinkSuggestionsResponseSchema,
    options,
  );

  const seen = new Set<string>();
  const suggestions: LinkSuggestion[] = [];
  for (const link of response.links) {
    const source = request.notes[link.from];
    const target = request.notes[link.to];
    // A position past the end of the list is the shape an invented note
    // takes. So is a note linked to itself.
    if (!source || !target || source.id === target.id) continue;
    // One suggestion per pair, whichever way round the model wrote it, and
    // none for a pair the student already linked.
    const pair = [source.id, target.id].sort().join('>');
    if (seen.has(pair)) continue;
    if (
      request.linked.has(`${source.id}>${target.id}`) ||
      request.linked.has(`${target.id}>${source.id}`)
    ) {
      continue;
    }
    seen.add(pair);
    suggestions.push({ sourceId: source.id, targetId: target.id, reason: link.reason });
    if (suggestions.length >= MAX_LINK_SUGGESTIONS) break;
  }
  return suggestions;
}
