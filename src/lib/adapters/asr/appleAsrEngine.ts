/**
 * macOS's own speech recognition — `SpeechTranscriber`, through the
 * `notabene-speech` helper (plan §10.3). The default engine: on the device,
 * no model of ours to pin or download, word timings and real per-word
 * confidences, and the course's terms as contextual strings.
 *
 * It needs a language. `auto` is settled once per job by `detectLanguage`,
 * which listens to the lecture's first speech in each candidate and keeps the
 * one the recogniser is sure of.
 */
import { AppleDetectSchema, AppleTranscriptWindowSchema } from '@/lib/schema';
import type { AsrAdapter } from './AsrAdapter';
import type {
  AsrEngine,
  AsrEngineCapabilities,
  AsrEngineState,
  AsrLanguage,
} from './AsrEngine';

/** The recogniser's locale for each language a lecture may be in. */
export const APPLE_LOCALES: Record<AsrLanguage, string> = {
  fr: 'fr-FR',
  en: 'en-US',
};

const CAPABILITIES: AsrEngineCapabilities = {
  local: true,
  window: { seconds: 300, overlapSeconds: 3 },
  wordTimestamps: true,
  confidences: true,
  languageHint: true,
  vocabulary: 'contextual-strings',
  maxVocabularyTerms: 100,
  provider: null,
};

function languageOf(locale: string): AsrLanguage | null {
  const entry = Object.entries(APPLE_LOCALES).find(([, value]) => value === locale);
  return entry ? (entry[0] as AsrLanguage) : null;
}

/** A killed helper answers `cancelled`; the pipeline reads an `AbortError`. */
async function cancellable<T>(
  adapter: AsrAdapter,
  jobId: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
  const onAbort = () => void adapter.cancel(jobId);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function createAppleAsrEngine(adapter: AsrAdapter): AsrEngine {
  return {
    id: 'apple-speech',

    capabilities: () => CAPABILITIES,

    async status(): Promise<AsrEngineState> {
      if (!adapter.supported()) {
        return {
          kind: 'unsupported',
          code: 'ASR_UNSUPPORTED',
          reason: 'ASR_UNSUPPORTED: transcription needs the desktop app',
        };
      }
      const status = await adapter.appleStatus([]).catch(() => null);
      if (!status?.available) {
        return {
          kind: 'unsupported',
          code: 'ASR_UNSUPPORTED_OS',
          reason: 'ASR_UNSUPPORTED_OS: on-device transcription needs macOS 26 or later',
        };
      }
      return { kind: 'ready' };
    },

    async detectLanguage(job, candidates, signal) {
      const raw = await cancellable(adapter, job.jobId, signal, () =>
        adapter.appleDetect(
          job.jobId,
          candidates.map((language) => APPLE_LOCALES[language]),
        ),
      );
      const parsed = AppleDetectSchema.safeParse(raw);
      const language = parsed.success ? languageOf(parsed.data.language) : null;
      if (!language) {
        throw new Error('ASR_INVALID_RESPONSE: the speech helper named no language');
      }
      return language;
    },

    async transcribeWindow(job, window, options) {
      if (!options.language) {
        throw new Error('ASR_LANGUAGE_REQUIRED: choose the lecture’s language');
      }
      const locale = APPLE_LOCALES[options.language];
      const raw = await cancellable(adapter, job.jobId, options.signal, () =>
        adapter.appleTranscribe(
          job.jobId,
          window.index,
          locale,
          options.vocabulary.slice(0, CAPABILITIES.maxVocabularyTerms),
        ),
      );
      const parsed = AppleTranscriptWindowSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error('ASR_INVALID_RESPONSE: the speech helper answered nonsense');
      }
      return { segments: parsed.data.segments, language: options.language };
    },
  };
}
