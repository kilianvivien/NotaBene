/**
 * Folding several notes into one document.
 *
 * Pure: no adapter, no store. `mergeNotesCommand` fetches the notes, orders
 * them and writes the result; everything about what the merged document *looks
 * like* lives here, where it can be tested without a library.
 *
 * Two decisions carry the shape:
 *
 * 1. **Each source keeps its title, as a heading.** A merge that concatenates
 *    bodies produces a document nobody can navigate back out of — which
 *    paragraph came from which lecture stops being recoverable the moment the
 *    originals go to the trash.
 * 2. **The source's own headings move down one level.** Otherwise the title
 *    NotaBene adds and the `# Introduction` the student wrote sit at the same
 *    rank, and the outline — in the editor, in the exported PDF's table of
 *    contents, in the DOCX navigation pane — reads as a flat list of unrelated
 *    sections. Level 6 stays put: there is no level 7, and dropping the text
 *    would be worse than a collision.
 */
import type { DocNode, NoteDoc } from '@/lib/schema';

/** The deepest heading ProseMirror's schema knows about. */
const MAX_HEADING_LEVEL = 6;

export interface MergeSource {
  title: string;
  doc: NoteDoc;
}

export interface MergeDocsOptions {
  /** Shown as the heading for a source whose title is empty. */
  untitledLabel: string;
}

/**
 * Build the merged document, in the order given.
 *
 * Ordering is the caller's business — `mergeNotesCommand` sorts by
 * `updatedAt` — because "which note goes on top" is a product decision and this
 * function should stay honest about doing exactly what it is told.
 */
export function mergeNoteDocs(
  sources: MergeSource[],
  options: MergeDocsOptions,
): NoteDoc {
  const content: DocNode[] = [];

  for (const [index, source] of sources.entries()) {
    // Between sources only: a rule above the first heading is a line under the
    // note's own title, which reads as decoration rather than a boundary.
    if (index > 0) content.push({ type: 'horizontalRule' });
    content.push({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: source.title.trim() || options.untitledLabel }],
    });
    content.push(...source.doc.content.map(demoteHeadings));
  }

  // ProseMirror's document may not be empty, and merging notes that are all
  // blank is a thing a student can do by accident.
  if (!content.length) content.push({ type: 'paragraph' });
  return { type: 'doc', content };
}

/**
 * Push every heading in a subtree down one level.
 *
 * Recursive because headings live inside callouts, columns and table cells as
 * well as at the top of the document, and a merge that fixed only the outer
 * level would leave those contradicting it.
 */
export function demoteHeadings(node: DocNode): DocNode {
  const content = node.content?.map(demoteHeadings);
  if (node.type !== 'heading') {
    return content ? { ...node, content } : node;
  }
  const level = Number(node.attrs?.level ?? 1);
  return {
    ...node,
    attrs: {
      ...node.attrs,
      level: Math.min(MAX_HEADING_LEVEL, (Number.isFinite(level) ? level : 1) + 1),
    },
    ...(content ? { content } : {}),
  };
}
