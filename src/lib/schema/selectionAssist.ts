import { z } from 'zod';

export const SelectionAssistInputSchema = z.object({
  text: z.string().trim().min(1).max(4_000),
  mode: z.enum(['correct', 'rewrite']),
});
export const SelectionAssistResponseSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
});
