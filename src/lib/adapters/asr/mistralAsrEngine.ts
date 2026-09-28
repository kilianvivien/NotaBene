/**
 * Mistral's hosted transcription, `voxtral-mini-2602` (plan §10.3). Opt-in:
 * used only when the student picked it in Settings, with the same Keychain
 * key as the AI provider and speech, and never as a fallback for the
 * on-device engine.
 *
 * The audio does not pass through here. The request *names* a job window,
 * and `ai.rs` reads the file, encodes it and builds the form — so a lecture
 * reaches Mistral without ever being in the webview.
 */
import type { AiTransport } from '../ai/AiTransport';
import type { SecretsAdapter } from '../settings/SettingsAdapter';
import { secretKeyFor } from '@/lib/ai/providers';
import { MistralTranscriptionSchema } from '@/lib/schema';
import type { AsrEngine, AsrEngineCapabilities } from './AsrEngine';

const URL = 'https://api.mistral.ai/v1/audio/transcriptions';
/** Pinned, not `-latest`, for the reason the speech engine pins its model:
 * a silent model change under a released app is an untested one. */
const MODEL = 'voxtral-mini-2602';
const MISTRAL_SECRET = secretKeyFor('mistral');

const CAPABILITIES: AsrEngineCapabilities = {
  local: false,
  // Billed per minute either way; windows buy a progress bar, a cancel that
  // lands within ten minutes, and a failure that costs one window.
  window: { seconds: 600, overlapSeconds: 3 },
  wordTimestamps: false,
  confidences: false,
  // `language` and `timestamp_granularities` are documented as incompatible,
  // and the transcript needs its timings.
  languageHint: false,
  vocabulary: 'context-bias',
  maxVocabularyTerms: 100,
  provider: 'mistral',
};

/** The provider's own words where it gave some; never a raw body. */
function errorMessage(status: number, body: string): string {
  try {
    const value = JSON.parse(body) as {
      message?: unknown;
      detail?: unknown;
      error?: { message?: unknown };
    };
    const detail = value.error?.message ?? value.message ?? value.detail;
    if (typeof detail === 'string' && detail.trim()) {
      return `ASR_API_ERROR: ${status} ${detail.trim()}`;
    }
  } catch {
    // Fall through to the status alone.
  }
  return `ASR_API_ERROR: Mistral transcription failed (${status})`;
}

export function createMistralAsrEngine(
  transport: AiTransport,
  secrets: SecretsAdapter,
): AsrEngine {
  return {
    id: 'mistral-api',

    capabilities: () => CAPABILITIES,

    async status() {
      const keys = await secrets.listKeys().catch(() => [] as string[]);
      return keys.includes(MISTRAL_SECRET)
        ? ({ kind: 'ready' } as const)
        : ({ kind: 'not_configured' } as const);
    },

    async transcribeWindow(job, window, options) {
      const key = await secrets.get(MISTRAL_SECRET);
      if (!key) throw new Error('ASR_API_KEY_MISSING: connect Mistral AI first');
      if (options.signal?.aborted) throw new DOMException('cancelled', 'AbortError');

      const fields: [string, string][] = [
        ['model', MODEL],
        ['timestamp_granularities', 'segment'],
        ...options.vocabulary
          .slice(0, CAPABILITIES.maxVocabularyTerms)
          .map((term): [string, string] => ['context_bias', term]),
      ];
      const response = await transport.request({
        url: URL,
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
        audio: { fields, fileField: 'file', jobId: job.jobId, index: window.index },
        signal: options.signal,
      });
      if (options.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      if (response.status < 200 || response.status >= 300) {
        throw new Error(errorMessage(response.status, response.body));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new Error('ASR_INVALID_RESPONSE: Mistral returned invalid JSON');
      }
      const parsed = MistralTranscriptionSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error('ASR_INVALID_RESPONSE: Mistral returned no usable transcript');
      }
      // Speech with no timings cannot be anchored; refusing beats inventing.
      if (!parsed.data.segments.length && parsed.data.text.trim()) {
        throw new Error('ASR_INVALID_RESPONSE: Mistral returned no timestamps');
      }
      return {
        segments: parsed.data.segments.map((segment) => ({ ...segment, words: [] })),
        language: parsed.data.language ?? null,
      };
    },
  };
}
