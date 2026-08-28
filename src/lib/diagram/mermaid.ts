/**
 * Mermaid source in, a drawing out.
 *
 * The result is a real Excalidraw scene, not a picture of one: the student can
 * open the block, drag a box, recolour an arrow, and the diagram is theirs from
 * then on. That is the reason this goes through `mermaid-to-excalidraw` instead
 * of rendering Mermaid to SVG directly, and the reason `schema.ts` restricts
 * the model to the three diagram types that convert to elements — the others
 * arrive as a raster image welded into the scene.
 *
 * Both halves are loaded on demand. Excalidraw and Mermaid together are the
 * largest thing the app can pull in, and a student who never asks for a diagram
 * should never pay for one; the drawing block already lazy-loads its editor for
 * exactly this reason.
 */
import type { NoteDoc } from '@/lib/schema';

/** What a `drawing` node stores. Same shape `DrawingEditor` saves, because it
 * is the same block — a generated diagram and a hand-drawn one must be
 * indistinguishable once they are in the note. */
export interface DrawingScene {
  data: { elements: unknown[]; appState: Record<string, unknown>; files: unknown };
  svg: string;
}

/** Thrown when Mermaid or the converter rejects the source. Separate from a
 * transport failure so the caller can tell "the model wrote bad Mermaid", which
 * is worth one more attempt, from "the provider is down", which is not. */
export class MermaidParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MermaidParseError';
  }
}

export async function mermaidToDrawing(mermaid: string): Promise<DrawingScene> {
  const [{ parseMermaidToExcalidraw }, { convertToExcalidrawElements, exportToSvg }] =
    await Promise.all([
      import('@excalidraw/mermaid-to-excalidraw'),
      import('@excalidraw/excalidraw'),
    ]);

  let skeleton;
  try {
    skeleton = await parseMermaidToExcalidraw(mermaid);
  } catch (error) {
    throw new MermaidParseError(error instanceof Error ? error.message : String(error));
  }

  const elements = convertToExcalidrawElements(skeleton.elements);
  if (!elements.length) {
    // Mermaid can accept a definition and still produce nothing to draw — an
    // empty flowchart parses. An empty drawing block is worse than an error,
    // because it looks like the feature ran and decided the note was blank.
    throw new MermaidParseError('the diagram parsed but contained no elements');
  }

  // The check that matters, and the reason it is here rather than left to the
  // schema's enum: an unsupported type does not fail, it silently comes back as
  // one `image` element — a picture welded into the scene that cannot be
  // edited. A model can also label a gantt chart "flowchart", which the enum
  // would wave through and this catches. Failing here buys the repair round
  // trip in `ai/diagram.ts`, which is the right outcome either way.
  if (elements.every((element) => element.type === 'image')) {
    throw new MermaidParseError(
      'that diagram type converts to a flat image rather than editable shapes',
    );
  }

  const files = skeleton.files ?? {};
  const svg = await exportToSvg({
    elements,
    appState: { exportBackground: false, viewBackgroundColor: 'transparent' },
    files,
  });

  return {
    // `appState` stays empty: the scene carries no view state of its own until
    // the student opens it, exactly as an inserted mind map carries none.
    data: { elements, appState: {}, files },
    svg: svg.outerHTML,
  };
}

/** The block a generated diagram becomes. */
export function drawingNode(
  scene: DrawingScene,
  title: string,
): NoteDoc['content'][number] {
  return {
    type: 'drawing',
    attrs: { data: scene.data, svg: scene.svg, title },
  };
}
