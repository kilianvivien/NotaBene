/**
 * Mind map: one note in, a tree of concepts out.
 *
 * The result is a block, not a note. A mind map of a lecture belongs *in* that
 * lecture's note — beside the material it summarises, exported with it, found
 * by the same search — rather than in a second note the student has to
 * remember exists.
 *
 * The SVG is rendered here rather than in the node view, so that the string
 * stored on the node is the same string every export path emits.
 */
import { docToMarkdown } from '@/editor/markdown';
import { mindMapToSvg } from '@/lib/mindmap/layout';
import { AiMindMapResponseSchema, type MindMap, type Note } from '@/lib/schema';
import { runAi, type AiRunOptions } from './client';
import { parseModelJson } from './json';
import { mindMapPrompt } from './prompts';
import type { ResolvedProvider } from './protocols';

export interface MindMapRequest {
  provider: ResolvedProvider;
  source: Pick<Note, 'title' | 'doc'>;
  language: string;
}

export interface MindMapResult {
  map: MindMap;
  svg: string;
}

export async function requestMindMap(
  request: MindMapRequest,
  options: AiRunOptions = {},
): Promise<MindMapResult> {
  const text = await runAi(
    {
      provider: request.provider,
      messages: mindMapPrompt({
        title: request.source.title,
        markdown: docToMarkdown(request.source.doc),
        language: request.language,
      }),
      maxTokens: 4_000,
      // Low: a map is a structural summary, and a model being creative about
      // which branches exist is a model inventing material the lecture did not
      // contain.
      temperature: 0.2,
      json: true,
      stream: false,
    },
    options,
  );

  const map = parseModelJson(AiMindMapResponseSchema, text);
  return { map, svg: mindMapToSvg(map) };
}
