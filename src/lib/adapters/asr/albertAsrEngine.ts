/** Albert's opt-in Whisper engine. Audio stays in Rust, sent as WAV because
 * Albert accepts WAV/MP3 only. The key is shared with the main AI provider. */
import { secretKeyFor } from '@/lib/ai/providers';
import { AlbertTranscriptionSchema } from '@/lib/schema';
import type { AiTransport } from '../ai/AiTransport';
import type { SecretsAdapter } from '../settings/SettingsAdapter';
import type { AsrEngine, AsrEngineCapabilities } from './AsrEngine';

const SECRET = secretKeyFor('albert');
const CAPABILITIES: AsrEngineCapabilities = {
  local: false,
  // 16 kHz mono PCM: under 10 MB per window, below Albert's 20 MB limit.
  window: { seconds: 300, overlapSeconds: 3 },
  wordTimestamps: false,
  confidences: false,
  // Albert's `language` requests translation when it differs from the audio.
  // Omit it to preserve the lecture's actual language, including mixed speech.
  languageHint: false,
  vocabulary: 'prompt',
  maxVocabularyTerms: 30,
  provider: 'albert',
};

export function createAlbertAsrEngine(
  transport: AiTransport,
  secrets: SecretsAdapter,
): AsrEngine {
  return {
    id: 'albert-api',
    capabilities: () => CAPABILITIES,

    async status() {
      const keys = await secrets.listKeys().catch(() => [] as string[]);
      return keys.includes(SECRET) ? { kind: 'ready' } : { kind: 'not_configured' };
    },

    async transcribeWindow(job, window, options) {
      if (options.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const key = await secrets.get(SECRET);
      if (!key) throw new Error('ASR_ALBERT_KEY_MISSING');
      if (options.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const fields: [string, string][] = [
        ['model', 'whisper-large-v3'],
        // The endpoint schema explicitly guarantees segments in this format.
        ['response_format', 'diarized_json'],
      ];
      const vocabulary = options.vocabulary.slice(0, CAPABILITIES.maxVocabularyTerms);
      if (vocabulary.length) fields.push(['prompt', vocabulary.join(', ')]);
      const response = await transport.request({
        url: 'https://albert.api.etalab.gouv.fr/v1/audio/transcriptions',
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
        audio: {
          fields,
          fileField: 'file',
          jobId: job.jobId,
          index: window.index,
          format: 'wav',
        },
        signal: options.signal,
      });
      if (options.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      if (response.status < 200 || response.status >= 300) {
        // Status only: provider bodies may echo prompts or private content.
        throw new Error(`ASR_ALBERT_API_ERROR: HTTP ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new Error('ASR_INVALID_RESPONSE');
      }
      const parsed = AlbertTranscriptionSchema.safeParse(payload);
      if (!parsed.success || (!parsed.data.segments.length && parsed.data.text.trim())) {
        throw new Error('ASR_INVALID_RESPONSE');
      }
      return {
        segments: parsed.data.segments.map((segment) => ({ ...segment, words: [] })),
        language: null,
      };
    },
  };
}
