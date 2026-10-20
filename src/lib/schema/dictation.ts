import { z } from 'zod';

export const DictationTextSchema = z.string().max(100_000);
export const DictationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('transcription.text.delta'), text: DictationTextSchema }),
  z.object({ type: z.literal('transcription.done'), text: z.string().max(2_000_000) }),
]);
