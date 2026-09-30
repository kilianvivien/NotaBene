/**
 * Diagram: one note in, an editable Excalidraw scene out.
 *
 * The sibling of `mindmap.ts`, and deliberately shaped like it — a block for
 * the note it describes, with the SVG rendered here so the string stored on the
 * node is the string every export path emits.
 *
 * The model returns an editorial plan and a bounded graph. Mermaid is compiled
 * locally from validated nodes and edges, keeping syntax work out of the model's
 * task. The conversion gate still checks that the resulting scene is editable;
 * a converter rejection earns one attempt to revise the plan.
 */
import {
  AiDiagramPlanSchema,
  VisualizationEditorialSchema,
  type AiDiagramResponse,
  type Note,
  type VisualizationEditorial,
} from '@/lib/schema';
import {
  mermaidToDrawing,
  MermaidParseError,
  type DrawingScene,
} from '@/lib/diagram/mermaid';
import type { AiRunOptions } from './client';
import { runStructured } from './structured';
import { diagramPrompt, mermaidRepairPrompt } from './prompts';
import type { ResolvedProvider } from './protocols';
import { plannedMermaid, visualizationMarkdown } from './visualization';

export interface DiagramRequest {
  provider: ResolvedProvider;
  source: Pick<Note, 'title' | 'doc'>;
  language: string;
}

export interface DiagramResult {
  answer: AiDiagramResponse;
  scene: DrawingScene;
  editorial?: VisualizationEditorial;
}

export async function requestDiagram(
  request: DiagramRequest,
  options: AiRunOptions = {},
): Promise<DiagramResult> {
  const messages = diagramPrompt({
    title: request.source.title,
    markdown: visualizationMarkdown(request.source.doc),
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

  const plan = await runStructured(call, AiDiagramPlanSchema, options);
  const answer = { title: plan.title, kind: plan.kind, mermaid: plannedMermaid(plan) };

  try {
    return {
      answer,
      scene: await mermaidToDrawing(answer.mermaid),
      editorial: VisualizationEditorialSchema.parse(plan),
    };
  } catch (error) {
    if (!(error instanceof MermaidParseError)) throw error;
    if (options.signal?.aborted) throw error;

    const repairedPlan = await runStructured(
      {
        ...call,
        messages: mermaidRepairPrompt(messages, JSON.stringify(plan), error.message),
        temperature: 0,
      },
      AiDiagramPlanSchema,
      options,
    );

    const repaired = {
      title: repairedPlan.title,
      kind: repairedPlan.kind,
      mermaid: plannedMermaid(repairedPlan),
    };
    // A second parse failure throws `MermaidParseError` on its own, which the
    // command layer turns into "the model could not draw this note" — the
    // honest message, and better than showing a student Mermaid line numbers.
    return {
      answer: repaired,
      scene: await mermaidToDrawing(repaired.mermaid),
      editorial: VisualizationEditorialSchema.parse(repairedPlan),
    };
  }
}
