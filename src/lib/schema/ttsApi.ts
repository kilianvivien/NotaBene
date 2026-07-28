import { z } from 'zod';

export const MistralTtsVoiceListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      languages: z.array(z.string().min(1)).default([]),
    }),
  ),
});

export const MistralTtsSpeechSchema = z.object({
  audio_data: z.string().min(1),
});

export const GeminiTtsSpeechSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(
            z.object({
              inlineData: z
                .object({
                  data: z.string().min(1),
                  mimeType: z.string().optional(),
                })
                .optional(),
            }),
          ),
        }),
      }),
    )
    .min(1),
});
