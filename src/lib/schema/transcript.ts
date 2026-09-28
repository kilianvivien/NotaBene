/**
 * Transcription's contract (plan §10.3).
 *
 * What an engine returns crosses a trust boundary twice over — a process that
 * read untrusted audio, or a provider's JSON — so it is parsed here before any
 * of it can reach a note. Times are seconds from the start of whatever was
 * sent: a window, for every engine; the pipeline shifts them onto the
 * lecture's clock.
 *
 * `confidence` is `null` where an engine has none. Never fold "no data" into
 * a number: a passage flagged for review because an engine reported nothing
 * is noise, and one left unflagged because "no data" read as 1.0 is worse.
 */
import { z } from 'zod';

const seconds = z.number().finite().nonnegative();

export const TranscriptWordSchema = z.object({
  text: z.string().min(1),
  start: seconds,
  end: seconds,
  confidence: z.number().min(0).max(1).nullable(),
});
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const TranscriptSegmentSchema = z.object({
  start: seconds,
  end: seconds,
  text: z.string(),
  words: z.array(TranscriptWordSchema).default([]),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/** One window from `notabene-speech transcribe`. */
export const AppleTranscriptWindowSchema = z.object({
  language: z.string().min(2),
  segments: z.array(TranscriptSegmentSchema),
});

/** `notabene-speech status`. */
export const AppleSpeechStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  languages: z.array(
    z.object({
      locale: z.string().min(2),
      status: z.enum(['installed', 'supported', 'downloading', 'unsupported']),
    }),
  ),
});
export type AppleSpeechStatus = z.infer<typeof AppleSpeechStatusSchema>;

/** `notabene-speech detect`. */
export const AppleDetectSchema = z.object({
  language: z.string().min(2),
  scores: z.record(z.number()).default({}),
});

/**
 * Mistral's `POST /v1/audio/transcriptions` with segment timestamps.
 *
 * Written from the API reference, not yet from a recorded response (plan
 * §10.3 step 1 owes that fixture), so it asks only for what a transcript
 * cannot do without and lets the rest pass: words are read if a segment
 * carries them, and a segment without times is refused rather than guessed.
 */
export const MistralTranscriptionSchema = z.object({
  text: z.string().default(''),
  language: z.string().nullable().optional(),
  segments: z
    .array(
      z.object({
        text: z.string(),
        start: seconds,
        end: seconds,
      }),
    )
    .default([]),
});
