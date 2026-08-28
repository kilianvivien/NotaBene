/**
 * Diagram: one note in, an editable Excalidraw scene out.
 *
 * The sibling of `mindmap.ts`, and deliberately shaped like it — a block for
 * the note it describes, with the SVG rendered here so the string stored on the
 * node is the string every export path emits.
 *
 * What is different is the second gate. A mind map's JSON *is* the artefact, so
 * parsing it is the whole check. Here the model returns Mermaid, and JSON that
 * validates can still carry a diagram Mermaid refuses to parse — a real and
 * frequent failure, because models write Mermaid from memory. So the answer is
 * converted before the student ever sees it, and a conversion failure buys one
 * repair round trip rather than an error message about syntax they did not
 * write. `runStructured` does the same for malformed JSON, one layer up.
 */
import { docToMarkdown } from '@/editor/markdown';
import { AiDiagramResponseSchema, type AiDiagramResponse, type Note } from '@/lib/schema';
import {
  mermaidToDrawing,
  MermaidParseError,
  type DrawingScene,
} from '@/lib/diagram/mermaid';
import { runAi, type AiRunOptions } from './client';
import { parseModelJson } from './json';
import { runStructured } from './structured';
import { diagramPrompt, mermaidRepairPrompt } from './prompts';
import type { ResolvedProvider } from './protocols';

export interface DiagramRequest {
  provider: ResolvedProvider;
  source: Pick<Note, 'title' | 'doc'>;
  language: string;
}

export interface DiagramResult {
  answer: AiDiagramResponse;
  scene: DrawingScene;
}

export async function requestDiagram(
  request: DiagramRequest,
  options: AiRunOptions = {},
): Promise<DiagramResult> {
  const messages = diagramPrompt({
    title: request.source.title,
    markdown: docToMarkdown(request.source.doc),
    language: request.language,
  });

  const call = {
    provider: request.provider,
    messages,
    maxTokens: 4_000,
    // Low, for the reason the mind map gives: a diagram is a structural reading
    // of the note, and a model being inventive about the boxes is a model
    // drawing material the lecture did not contain.
    temperature: 0.2,
  };

  const answer = await runStructured(call, AiDiagramResponseSchema, options);

  try {
    return { answer, scene: await mermaidToDrawing(answer.mermaid) };
  } catch (error) {
    if (!(error instanceof MermaidParseError)) throw error;
    if (options.signal?.aborted) throw error;

    const second = await runAi(
      {
        ...call,
        messages: mermaidRepairPrompt(messages, JSON.stringify(answer), error.message),
        temperature: 0,
        json: true,
        stream: false,
      },
      options,
    );

    const repaired = parseModelJson(AiDiagramResponseSchema, second);
    // A second parse failure throws `MermaidParseError` on its own, which the
    // command layer turns into "the model could not draw this note" — the
    // honest message, and better than showing a student Mermaid line numbers.
    return { answer: repaired, scene: await mermaidToDrawing(repaired.mermaid) };
  }
}
