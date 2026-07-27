/**
 * Document → text projections.
 *
 * `plainText` is what FTS5 indexes, what list snippets show, and what the word
 * count reports, so it has to be derived the same way everywhere. Everything
 * that needs to read a document as text goes through this file.
 */
import type { DocNode, NoteDoc } from '@/lib/schema';

/** Block types that should force a line break when flattened. */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'taskItem',
  'codeBlock',
  'callout',
  'toggle',
  'tableRow',
  'horizontalRule',
]);

function walk(node: DocNode, out: string[]): void {
  if (node.text) out.push(node.text);

  // Math and drawings carry their content in attrs, not children; a LaTeX
  // formula is very much something a student searches for.
  if (node.type === 'math' || node.type === 'mathBlock') {
    const latex = node.attrs?.latex;
    if (typeof latex === 'string') out.push(latex);
  }
  if (node.type === 'image') {
    const caption = node.attrs?.caption;
    const alt = node.attrs?.alt;
    if (typeof caption === 'string') out.push(caption);
    else if (typeof alt === 'string') out.push(alt);
  }

  for (const child of node.content ?? []) walk(child, out);

  if (BLOCK_TYPES.has(node.type)) out.push('\n');
}

/** Flatten a note document to searchable, snippet-able text. */
export function flattenDoc(doc: NoteDoc): string {
  const out: string[] = [];
  for (const node of doc.content) walk(node, out);
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const FEATURE_NODE_TYPES: Record<'image' | 'drawing' | 'table', string[]> = {
  image: ['image'],
  drawing: ['drawing', 'excalidraw'],
  table: ['table'],
};

/** Backs the `has:image` / `has:drawing` / `has:table` search filters. */
export function docHasFeature(doc: NoteDoc, feature: 'image' | 'drawing' | 'table'): boolean {
  const wanted = new Set(FEATURE_NODE_TYPES[feature]);
  const stack: DocNode[] = [...doc.content];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (wanted.has(node.type)) return true;
    if (node.content) stack.push(...node.content);
  }
  return false;
}

/**
 * Derive a title from the first heading or paragraph. Students rarely stop to
 * name a note mid-lecture, so an untitled note borrows its first line rather
 * than showing up as "Untitled" in the list.
 */
export function deriveTitle(doc: NoteDoc, fallback: string): string {
  for (const node of doc.content) {
    const text = flattenDoc({ type: 'doc', content: [node] }).trim();
    // `text` is non-empty here, so the first line exists; the fallback keeps
    // the compiler honest without pretending to know that.
    if (text) return (text.split('\n')[0] ?? text).slice(0, 120);
  }
  return fallback;
}

export interface DocStats {
  words: number;
  characters: number;
  /** Minutes, at the ~200 wpm most reading-time estimators assume. */
  readingMinutes: number;
}

export function docStats(doc: NoteDoc): DocStats {
  const text = flattenDoc(doc);
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    words,
    characters: text.length,
    readingMinutes: Math.max(1, Math.round(words / 200)),
  };
}
