import type { AiTransport } from '../ai/AiTransport';
import type { SecretsAdapter } from '../settings/SettingsAdapter';
import { secretKeyFor } from '@/lib/ai/providers';
import { parseWav, wavDurationMs } from '@/lib/podcast/wav';
import { MistralTtsSpeechSchema, MistralTtsVoiceListSchema } from '@/lib/schema/ttsApi';
import type {
  TtsEngine,
  TtsEngineCapabilities,
  TtsRequest,
  TtsSegmentResult,
  TtsVoice,
} from './TtsEngine';

const BASE_URL = 'https://api.mistral.ai/v1';
const MODEL = 'voxtral-mini-tts-2603';
const MISTRAL_SECRET = secretKeyFor('mistral');

const CAPABILITIES: TtsEngineCapabilities = {
  local: false,
  streaming: false,
  supportsRate: 'playback',
  supportsPitch: false,
  supportsVoiceCloning: true,
  sampleRateHz: null,
  channels: 1,
  formats: ['wav'],
};

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new Error('TTS_AUDIO_INVALID: Mistral returned invalid base64 audio');
  }
}

function errorMessage(status: number, body: string): string {
  try {
    const value = JSON.parse(body) as {
      message?: unknown;
      detail?: unknown;
      error?: { message?: unknown };
    };
    const detail = value.error?.message ?? value.message ?? value.detail;
    if (typeof detail === 'string' && detail.trim()) {
      return `TTS_API_ERROR: ${status} ${detail.trim()}`;
    }
  } catch {
    // The status still identifies the failed request without echoing an
    // arbitrary provider response into the UI.
  }
  return `TTS_API_ERROR: Mistral speech request failed (${status})`;
}

async function apiKey(secrets: SecretsAdapter): Promise<string> {
  const key = await secrets.get(MISTRAL_SECRET);
  if (!key) throw new Error('TTS_API_KEY_MISSING: connect Mistral AI first');
  return key;
}

function headers(key: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

export function createMistralTtsEngine(
  transport: AiTransport,
  secrets: SecretsAdapter,
): TtsEngine {
  return {
    id: 'mistral-api',

    async capabilities() {
      return CAPABILITIES;
    },

    async status() {
      const keys = await secrets.listKeys();
      return keys.includes(MISTRAL_SECRET)
        ? ({ kind: 'ready' } as const)
        : ({ kind: 'not_configured' } as const);
    },

    async isAvailable() {
      return (await this.status()).kind === 'ready';
    },

    async listVoices(): Promise<TtsVoice[]> {
      const key = await apiKey(secrets);
      const response = await transport.request({
        url: `${BASE_URL}/audio/voices?limit=1000&type=all`,
        method: 'GET',
        headers: headers(key),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(errorMessage(response.status, response.body));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new Error('TTS_API_INVALID_RESPONSE: Mistral returned invalid JSON');
      }
      const parsed = MistralTtsVoiceListSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error('TTS_API_INVALID_RESPONSE: Mistral returned invalid voices');
      }
      return parsed.data.items.map((voice) => ({
        id: voice.id,
        name: voice.name,
        locale: voice.languages[0] ?? 'mul',
        quality: 'premium',
      }));
    },

    async synthesize(
      request: TtsRequest,
      signal?: AbortSignal,
    ): Promise<TtsSegmentResult> {
      const text = request.text.trim();
      if (!text || text.split(/\s+/).length > 300) {
        throw new Error('TTS_GENERATION_FAILED: text must contain 1–300 words');
      }
      if (!request.voiceId) {
        throw new Error('TTS_GENERATION_FAILED: choose a Mistral voice');
      }
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');

      const key = await apiKey(secrets);
      const response = await transport.request({
        url: `${BASE_URL}/audio/speech`,
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({
          model: MODEL,
          input: text,
          voice_id: request.voiceId,
          response_format: 'wav',
          stream: false,
        }),
        signal,
      });
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      if (response.status < 200 || response.status >= 300) {
        throw new Error(errorMessage(response.status, response.body));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new Error('TTS_API_INVALID_RESPONSE: Mistral returned invalid JSON');
      }
      const parsed = MistralTtsSpeechSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error('TTS_API_INVALID_RESPONSE: Mistral returned no audio');
      }

      const bytes = decodeBase64(parsed.data.audio_data);
      let wav;
      try {
        wav = parseWav(bytes);
      } catch {
        throw new Error('TTS_AUDIO_INVALID: Mistral returned an invalid WAV file');
      }
      if (wav.format.channels !== 1 && wav.format.channels !== 2) {
        throw new Error('TTS_AUDIO_INVALID: Mistral returned unsupported channel count');
      }

      return {
        audio: new Blob([bytes], { type: 'audio/wav' }),
        durationMs: wavDurationMs(wav),
        sampleRateHz: wav.format.sampleRate,
        channels: wav.format.channels,
      };
    },
  };
}
