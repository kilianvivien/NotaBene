/**
 * What a provider says it can run.
 *
 * A model listing is a payload from outside, so it is parsed rather than
 * trusted — same rule as an LLM's JSON or an MCP body. The schemas are narrow
 * on purpose: every runtime adds fields between releases, and a listing that
 * failed to parse because LM Studio started reporting a quantisation we had not
 * seen would break auto-detection for no gain. Only the fields we read appear.
 */
import { z } from 'zod';

/** The OpenAI `/models` shape, which every compatible server implements. */
export const OpenAiModelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

/**
 * LM Studio's own REST listing, which the OpenAI one cannot replace: it is the
 * only endpoint that says which of the downloaded models is *in memory*, and
 * that is the one a request should go to. Anything else makes LM Studio load a
 * second model on the first prompt.
 */
export const LmStudioModelListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      state: z.string().optional(),
    }),
  ),
});

/** Ollama's `/api/ps` — models resident right now, with their eviction time. */
export const OllamaRunningModelsSchema = z.object({
  models: z
    .array(
      z.object({
        // `name` carries the tag (`qwen3:8b`); `model` repeats it on current
        // builds and is absent on older ones.
        name: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      }),
    )
    .default([]),
});
