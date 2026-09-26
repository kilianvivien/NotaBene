/**
 * What "discreet", "balanced" and "eager" mean for completion.
 *
 * The student picks how present the feature is; this is where that choice
 * becomes thresholds. Every lever moves together — a discreet completer that
 * harvested every four-letter word but only offered long endings would feel
 * random rather than quiet.
 */
import type { CompletionPresence } from '@/lib/adapters';
import { HARVEST_DEFAULTS, LIBRARY_HARVEST, type HarvestOptions } from './harvest';

export interface PresenceProfile {
  /** Harvest thresholds for a course's notes. */
  course: Required<Omit<HarvestOptions, 'keyTerms'>>;
  /** …and for a note with no course, drawing on the whole library. */
  library: Required<Omit<HarvestOptions, 'keyTerms'>>;
  /** Uses within the open note before one of its words is offered. */
  noteMinCount: number;
  /** Fewest letters a suggestion must add. Completing "cellul" to "cellule"
   * costs a Tab to save one letter; a discreet completer does not bother. */
  minRest: number;
}

export const PRESENCE_PROFILES: Record<CompletionPresence, PresenceProfile> = {
  quiet: {
    course: { minLength: 7, minNotes: 3, minCount: 5, limit: 5_000 },
    library: { minLength: 7, minNotes: 4, minCount: 8, limit: 5_000 },
    noteMinCount: 2,
    minRest: 3,
  },
  balanced: {
    course: HARVEST_DEFAULTS,
    library: LIBRARY_HARVEST,
    noteMinCount: 1,
    minRest: 2,
  },
  eager: {
    // One use anywhere in the course is enough: the rejected list and Escape
    // are the answer to a typo, and an eager completer is asked for.
    course: { minLength: 4, minNotes: 1, minCount: 1, limit: 8_000 },
    library: { minLength: 5, minNotes: 2, minCount: 2, limit: 8_000 },
    noteMinCount: 1,
    minRest: 1,
  },
};

export function presenceProfile(presence: CompletionPresence): PresenceProfile {
  return PRESENCE_PROFILES[presence] ?? PRESENCE_PROFILES.balanced;
}
