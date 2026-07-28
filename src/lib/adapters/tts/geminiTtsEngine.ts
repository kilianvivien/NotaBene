import type { AiResponse, AiTransport } from '../ai/AiTransport';
import type { SecretsAdapter } from '../settings/SettingsAdapter';
import { secretKeyFor } from '@/lib/ai/providers';
import { encodeWav, wavDurationMs } from '@/lib/podcast/wav';
import { GeminiTtsSpeechSchema } from '@/lib/schema/ttsApi';
import type {
  TtsEngine,
  TtsEngineCapabilities,
  TtsRequest,
  TtsSegmentResult,
  TtsVoice,
} from './TtsEngine';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_SECRET = secretKeyFor('gemini');
const SAMPLE_RATE = 24_000;

const VOICES = [
  ['Zephyr', 'Bright'],
  ['Puck', 'Upbeat'],
  ['Charon', 'Informative'],
  ['Kore', 'Firm'],
  ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'],
  ['Orus', 'Firm'],
  ['Aoede', 'Breezy'],
  ['Callirrhoe', 'Easy-going'],
  ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'],
  ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'],
  ['Algieba', 'Smooth'],
  ['Despina', 'Smooth'],
  ['Erinome', 'Clear'],
  ['Algenib', 'Gravelly'],
  ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'],
  ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'],
  ['Schedar', 'Even'],
  ['Gacrux', 'Mature'],
  ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'],
  ['Vindemiatrix', 'Gentle'],
  ['Sadachbia', 'Lively'],
  ['Sadaltager', 'Knowledgeable'],
  ['Sulafat', 'Warm'],
] as const;

const CAPABILITIES: TtsEngineCapabilities = {
  local: false,
  streaming: false,
  supportsRate: 'playback',
  supportsPitch: false,
  supportsVoiceCloning: false,
  sampleRateHz: SAMPLE_RATE,
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
    throw new Error('TTS_AUDIO_INVALID: Gemini returned invalid base64 audio');
  }
}

function errorMessage(status: number, body: string): string {
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown } };
    const detail = value.error?.message;
    if (typeof detail === 'string' && detail.trim()) {
      return `TTS_API_ERROR: ${status} ${detail.trim()}`;
    }
  } catch {
    // Keep arbitrary provider response bodies out of the UI.
  }
  return `TTS_API_ERROR: Gemini speech request failed (${status})`;
}

async function apiKey(secrets: SecretsAdapter): Promise<string> {
  const key = await secrets.get(GEMINI_SECRET);
  if (!key) throw new Error('TTS_API_KEY_MISSING: connect Google Gemini first');
  return key;
}

async function requestWithPreviewRetry(
  transport: AiTransport,
  request: Parameters<AiTransport['request']>[0],
): Promise<AiResponse> {
  let response = await transport.request(request);
  // Google documents rare transient 500s when this preview model emits text
  // tokens instead of audio tokens. One retry covers that case without hiding
  // persistent provider failures or multiplying a bill indefinitely.
  if (response.status === 500 && !request.signal?.aborted) {
    response = await transport.request(request);
  }
  return response;
}

export function createGeminiTtsEngine(
  transport: AiTransport,
  secrets: SecretsAdapter,
): TtsEngine {
  return {
    id: 'gemini-api',

    async capabilities() {
      return CAPABILITIES;
    },

    async status() {
      const keys = await secrets.listKeys();
      return keys.includes(GEMINI_SECRET)
        ? ({ kind: 'ready' } as const)
        : ({ kind: 'not_configured' } as const);
    },

    async isAvailable() {
      return (await this.status()).kind === 'ready';
    },

    async listVoices(): Promise<TtsVoice[]> {
      await apiKey(secrets);
      return VOICES.map(([id, style]) => ({
        id,
        name: `${id} · ${style}`,
        locale: 'mul',
        quality: 'premium',
      }));
    },

    async synthesize(
      request: TtsRequest,
      signal?: AbortSignal,
    ): Promise<TtsSegmentResult> {
      const text = request.text.trim();
      if (!text) throw new Error('TTS_GENERATION_FAILED: text must not be empty');
      if (!request.voiceId) {
        throw new Error('TTS_GENERATION_FAILED: choose a Gemini voice');
      }
      if (!VOICES.some(([id]) => id === request.voiceId)) {
        throw new Error('TTS_GENERATION_FAILED: unknown Gemini voice');
      }
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');

      const key = await apiKey(secrets);
      const response = await requestWithPreviewRetry(transport, {
        url: `${BASE_URL}/models/${MODEL}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Read the following transcript aloud exactly as written. Do not add or omit words.\n\nTranscript:\n${text}`,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: request.voiceId },
              },
            },
          },
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
        throw new Error('TTS_API_INVALID_RESPONSE: Gemini returned invalid JSON');
      }
      const parsed = GeminiTtsSpeechSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error('TTS_API_INVALID_RESPONSE: Gemini returned no audio');
      }
      const audioData = parsed.data.candidates
        .flatMap((candidate) => candidate.content.parts)
        .find((part) => part.inlineData?.data)?.inlineData?.data;
      if (!audioData) {
        throw new Error('TTS_API_INVALID_RESPONSE: Gemini returned no audio');
      }

      const pcm = decodeBase64(audioData);
      if (!pcm.byteLength || pcm.byteLength % 2 !== 0) {
        throw new Error('TTS_AUDIO_INVALID: Gemini returned invalid 16-bit PCM');
      }
      const wav = encodeWav({
        format: { sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16 },
        samples: pcm,
      });

      return {
        audio: new Blob([wav], { type: 'audio/wav' }),
        durationMs: wavDurationMs({
          format: { sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16 },
          samples: pcm,
        }),
        sampleRateHz: SAMPLE_RATE,
        channels: 1,
      };
    },
  };
}
