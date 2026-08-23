import type { DocNode, NoteDoc } from '@/lib/schema';

export interface DocumentNoteReference {
  node: DocNode;
  id: string;
  kind: 'footnote' | 'endnote';
  number: number;
  note: string;
}

/** Collect semantic note references in reading order. Footnotes and endnotes
 * have independent visible numbering, while `id` remains unique in the file. */
export function documentNoteReferences(doc: NoteDoc): DocumentNoteReference[] {
  const result: DocumentNoteReference[] = [];
  let footnotes = 0;
  let endnotes = 0;
  const walk = (node: DocNode) => {
    if (node.type === 'footnote') {
      const kind = node.attrs?.kind === 'endnote' ? 'endnote' : 'footnote';
      const number = kind === 'endnote' ? ++endnotes : ++footnotes;
      result.push({
        node,
        id: `${kind === 'endnote' ? 'en' : 'fn'}-${number}`,
        kind,
        number,
        note: String(node.attrs?.note ?? ''),
      });
    }
    for (const child of node.content ?? []) walk(child);
  };
  for (const node of doc.content) walk(node);
  return result;
}
