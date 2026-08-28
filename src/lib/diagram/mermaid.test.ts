/**
 * The conversion gate.
 *
 * Excalidraw and Mermaid are both mocked: this is not a test of whether Mermaid
 * parses Mermaid, it is a test of what happens to the two answers a model
 * actually gives — one that converts, and one that does not. The second is the
 * case the retry in `ai/diagram.ts` exists for, so it has to fail as a
 * `MermaidParseError` and not as something generic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const parseMermaidToExcalidraw = vi.fn();
const convertToExcalidrawElements = vi.fn();
const exportToSvg = vi.fn();

vi.mock('@excalidraw/mermaid-to-excalidraw', () => ({
  parseMermaidToExcalidraw: (...args: unknown[]) => parseMermaidToExcalidraw(...args),
}));

vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: (...args: unknown[]) =>
    convertToExcalidrawElements(...args),
  exportToSvg: (...args: unknown[]) => exportToSvg(...args),
}));

const { drawingNode, mermaidToDrawing, MermaidParseError } = await import('./mermaid');

beforeEach(() => {
  vi.clearAllMocks();
  parseMermaidToExcalidraw.mockResolvedValue({ elements: [{ type: 'rectangle' }] });
  convertToExcalidrawElements.mockReturnValue([{ id: 'a', type: 'rectangle' }]);
  exportToSvg.mockResolvedValue({ outerHTML: '<svg><rect /></svg>' });
});

describe('mermaidToDrawing', () => {
  it('returns a scene and the SVG that every export path will draw', async () => {
    const scene = await mermaidToDrawing('flowchart TD\n  A --> B');

    expect(parseMermaidToExcalidraw).toHaveBeenCalledWith('flowchart TD\n  A --> B');
    expect(scene.svg).toBe('<svg><rect /></svg>');
    expect(scene.data.elements).toEqual([{ id: 'a', type: 'rectangle' }]);
  });

  /** The scene is exported on transparent, like a hand-drawn one, so the note's
   * own background shows through in both themes. */
  it('exports without a background', async () => {
    await mermaidToDrawing('flowchart TD\n  A --> B');

    expect(exportToSvg).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: { exportBackground: false, viewBackgroundColor: 'transparent' },
      }),
    );
  });

  it('reports a refused diagram as a MermaidParseError, so the retry can fire', async () => {
    parseMermaidToExcalidraw.mockRejectedValue(new Error('Parse error on line 2'));

    await expect(mermaidToDrawing('flowchart TD\n  A -->')).rejects.toThrow(
      MermaidParseError,
    );
    await expect(mermaidToDrawing('flowchart TD\n  A -->')).rejects.toThrow(
      /Parse error on line 2/,
    );
  });

  /**
   * An empty flowchart is valid Mermaid. Letting it through would put an empty
   * drawing block in the note, which reads as "the feature ran and your note
   * had nothing in it" rather than as a failure.
   */
  it('refuses a diagram that parses but draws nothing', async () => {
    convertToExcalidrawElements.mockReturnValue([]);

    await expect(mermaidToDrawing('flowchart TD')).rejects.toThrow(MermaidParseError);
    expect(exportToSvg).not.toHaveBeenCalled();
  });

  /**
   * The silent failure this whole guard exists for. An unsupported diagram type
   * does not throw — the converter rasterises it and returns one `image`
   * element, a picture welded into the scene that the student cannot edit.
   * Measured against the real converter: class, state, ER, gantt and pie all
   * come back this way, including `class`, which Excalidraw's dialog claims to
   * support.
   */
  it('refuses a scene that came back as a flat image', async () => {
    convertToExcalidrawElements.mockReturnValue([{ id: 'a', type: 'image' }]);

    await expect(mermaidToDrawing('gantt\n  title A')).rejects.toThrow(
      /flat image rather than editable shapes/,
    );
    expect(exportToSvg).not.toHaveBeenCalled();
  });

  it('keeps a scene that merely contains an image beside real shapes', async () => {
    convertToExcalidrawElements.mockReturnValue([
      { id: 'a', type: 'image' },
      { id: 'b', type: 'rectangle' },
    ]);

    await expect(mermaidToDrawing('flowchart TD\n  A --> B')).resolves.toMatchObject({
      svg: '<svg><rect /></svg>',
    });
  });
});

describe('drawingNode', () => {
  it('builds the same block a hand-drawn diagram would', () => {
    const node = drawingNode(
      { data: { elements: [], appState: {}, files: {} }, svg: '<svg />' },
      'Glycolysis',
    );

    expect(node.type).toBe('drawing');
    expect(node.attrs).toMatchObject({ svg: '<svg />', title: 'Glycolysis' });
  });
});
