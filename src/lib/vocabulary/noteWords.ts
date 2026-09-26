/**
 * The open note's own words, for completion before they have had time to
 * recur across the course.
 *
 * The course index only learns a note after it is saved and harvested again,
 * which is minutes behind the lecture. A term introduced ten minutes ago in
 * this note is the likeliest word of all to come back, so the editor keeps
 * this small index alongside the course's and rebuilds it when typing pauses.
 */
import { CompletionIndex } from './completionIndex';
import { createHarvester } from './harvest';
import type { PresenceProfile } from './presence';

export function buildNoteIndex(text: string, profile: PresenceProfile): CompletionIndex {
  const harvester = createHarvester({
    minLength: profile.course.minLength,
    // A single note: `notes` is always one, so only the count can decide.
    minNotes: profile.noteMinCount <= 1 ? 1 : Number.POSITIVE_INFINITY,
    minCount: profile.noteMinCount,
    limit: 2_000,
  });
  harvester.add({ id: 'open-note', title: '', plainText: text });
  return new CompletionIndex(
    harvester.finish().map((term) => ({
      term: term.term,
      key: term.key,
      weight: term.count,
      curated: false,
    })),
  );
}
