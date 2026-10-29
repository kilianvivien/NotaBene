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

export function imageAtTarget(doc: NoteDoc, target: ImageDrawingTarget): DocNode | null {
  let nodes: DocNode[] | undefined = doc.content;
  let found: DocNode | undefined;
  for (const index of target.path) {
    found = nodes?.[index];
    nodes = found?.content;
  }
  return found?.type === 'image' && JSON.stringify(found) === JSON.stringify(target.image)
    ? found
    : null;
}
