/**
 * Note to podcast, part one: the script.
 *
 * Split from the audio deliberately. Writing the script is a provider call like
 * any other and belongs here; turning it into sound is a local, offline,
 * macOS-specific job that lives behind `TtsEngine`. Keeping them apart is what
 * lets a student read the script and decide it is not worth listening to before
 * spending two minutes synthesising it — and what will let Voxtral replace the
 * system voices later without this file changing.
 */
import { docToMarkdown } from '@/editor/markdown';
import { AiPodcastResponseSchema, type Note, type PodcastScript } from '@/lib/schema';
import { runAi, type AiRunOptions } from './client';
import { parseModelJson } from './json';
import { podcastPrompt, type PodcastMode } from './prompts';
import type { ResolvedProvider } from './protocols';

export type { PodcastMode };

export interface PodcastRequest {
  provider: ResolvedProvider;
  sources: Pick<Note, 'title' | 'doc'>[];
  mode: PodcastMode;
  /** Target length. Reaches the model as a word count, which it holds to far
   * better than it holds to a duration. */
  minutes: number;
  language: string;
}

/** Roughly what a synthesiser gets through in a minute at its default rate.
 * Used for the estimate shown beside the script, never for anything the player
 * depends on — the engine reports real durations once the audio exists. */
export const WORDS_PER_MINUTE = 150;

export function estimateSpokenMinutes(script: PodcastScript): number {
  const words = script.segments.reduce(
    (total, segment) => total + segment.text.split(/\s+/).filter(Boolean).length,
    0,
  );
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export async function requestPodcastScript(
  request: PodcastRequest,
  options: AiRunOptions = {},
): Promise<PodcastScript> {
  if (!request.sources.length) throw new Error('select at least one note');

  const text = await runAi(
    {
      provider: request.provider,
      messages: podcastPrompt({
        mode: request.mode,
        minutes: request.minutes,
        sources: request.sources.map((note) => ({
          title: note.title,
          markdown: docToMarkdown(note.doc),
        })),
        language: request.language,
      }),
      maxTokens: 12_000,
      // Higher than the other structured features: this one is prose meant to
      // be listened to for ten minutes, and a script written at 0.2 is a script
      // that sounds like a wikipedia summary read aloud.
      temperature: 0.6,
      json: true,
      stream: false,
    },
    options,
  );

  const script = parseModelJson(AiPodcastResponseSchema, text);
  return { ...script, mode: request.mode };
}
