import type { DocNode, NoteDoc } from '@/lib/schema';

export interface ImageDrawingTarget {
  noteId: string;
  path: number[];
  image: DocNode;
}

export function inlineImages(
  doc: NoteDoc,
): { assetId: string; path: number[]; image: DocNode }[] {
  const images: ReturnType<typeof inlineImages> = [];
  function walk(nodes: DocNode[], parent: number[]) {
    nodes.forEach((node, index) => {
      const path = [...parent, index];
      if (node.type === 'image' && typeof node.attrs?.assetId === 'string') {
        images.push({ assetId: node.attrs.assetId, path, image: node });
      }
      if (node.content) walk(node.content, path);
    });
  }
  walk(doc.content, []);
  return images;
}

/** Assets are content-addressed: caption edits, editor defaults and resizing
 * do not change the source bytes. Prefer the selected occurrence's position,
 * then follow a unique asset if surrounding blocks have moved it. */
export function locateImageTarget(
  doc: NoteDoc,
  target: ImageDrawingTarget,
): ReturnType<typeof inlineImages>[number] | null {
  const assetId = target.image.attrs?.assetId;
  if (typeof assetId !== 'string' || !assetId) return null;
  const candidates = inlineImages(doc).filter((image) => image.assetId === assetId);
  if (candidates.length === 1) return candidates[0]!;
  // Captions can distinguish copies of identical bytes. Normalise TipTap's
  // defaults before comparing, and do not replace a differently captioned copy
  // just because it has moved into the old position.
  const presentation = ({ attrs = {} }: DocNode) =>
    JSON.stringify([
      attrs.caption ?? '',
      attrs.alt ?? '',
      attrs.align ?? 'center',
      attrs.width ?? 640,
    ]);
  const matching = candidates.filter(
    ({ image }) => presentation(image) === presentation(target.image),
  );
  const atPosition = matching.find(
    ({ path }) =>
      path.length === target.path.length &&
      path.every((index, depth) => index === target.path[depth]),
  );
  // Multiple relocated copies are ambiguous; never overwrite an unrelated
  // block or guess which copy the student meant.
  return atPosition ?? (matching.length === 1 ? matching[0]! : null);
}
