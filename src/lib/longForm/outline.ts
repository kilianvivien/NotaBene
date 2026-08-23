import type { DocNode, NoteDoc } from '@/lib/schema';
import { docStats, flattenDoc } from '@/lib/notes/docText';

export interface OutlineEntry {
  /** Top-level document index of the heading. */
  index: number;
  title: string;
  level: number;
  end: number;
  words: number;
  target: number | null;
}

export interface WritingProgress {
  words: number;
  target: number;
  source: 'note' | 'sections';
}

function positiveTarget(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nodeText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(nodeText).join('');
}

/** The heading tree is implicit in levels; entries also carry their section
 * range so one derivation powers navigation, progress, and drag reordering. */
export function documentOutline(doc: NoteDoc): OutlineEntry[] {
  const headings = doc.content.flatMap((node, index) => {
    if (node.type !== 'heading') return [];
    return [
      {
        index,
        title: nodeText(node).trim(),
        level: Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))),
      },
    ];
  });

  return headings.map((heading, position) => {
    const next = headings
      .slice(position + 1)
      .find((candidate) => candidate.level <= heading.level);
    const end = next?.index ?? doc.content.length;
    const body = doc.content.slice(heading.index + 1, end);
    return {
      ...heading,
      end,
      words: docStats({ type: 'doc', content: body }).words,
      target: positiveTarget(doc.content[heading.index]?.attrs?.writingTarget),
    };
  });
}

export function noteWritingTarget(doc: NoteDoc): number | null {
  return positiveTarget(doc.attrs?.writingTarget);
}

export function writingProgress(doc: NoteDoc): WritingProgress | null {
  const noteTarget = noteWritingTarget(doc);
  if (noteTarget) {
    return { words: docStats(doc).words, target: noteTarget, source: 'note' };
  }
  const targeted = documentOutline(doc)
    .filter((entry): entry is OutlineEntry & { target: number } => entry.target !== null)
    .filter(
      (entry, _index, entries) =>
        !entries.some(
          (candidate) =>
            candidate.index < entry.index &&
            candidate.end >= entry.end &&
            candidate.level < entry.level,
        ),
    );
  if (!targeted.length) return null;
  return {
    words: targeted.reduce((sum, entry) => sum + entry.words, 0),
    target: targeted.reduce((sum, entry) => sum + entry.target, 0),
    source: 'sections',
  };
}

export function setWritingTarget(
  doc: NoteDoc,
  target: number | null,
  sectionIndex: number | null = null,
): NoteDoc {
  const value = positiveTarget(target);
  if (sectionIndex === null) {
    const attrs = { ...(doc.attrs ?? {}) };
    if (value) attrs.writingTarget = value;
    else delete attrs.writingTarget;
    return { ...doc, attrs: Object.keys(attrs).length ? attrs : undefined };
  }
  const node = doc.content[sectionIndex];
  if (node?.type !== 'heading') return doc;
  const attrs = { ...(node.attrs ?? {}) };
  if (value) attrs.writingTarget = value;
  else delete attrs.writingTarget;
  const content = [...doc.content];
  content[sectionIndex] = { ...node, attrs };
  return { ...doc, content };
}

/** Move a heading and every block in its section. A parent heading carries its
 * descendants; dropping onto one of those descendants is therefore a no-op. */
export function moveOutlineSection(
  doc: NoteDoc,
  sourceIndex: number,
  targetIndex: number,
): NoteDoc {
  if (sourceIndex === targetIndex) return doc;
  const source = documentOutline(doc).find((entry) => entry.index === sourceIndex);
  const target = documentOutline(doc).find((entry) => entry.index === targetIndex);
  if (!source || !target || (target.index > source.index && target.index < source.end)) {
    return doc;
  }
  const moved = doc.content.slice(source.index, source.end);
  const remaining = [
    ...doc.content.slice(0, source.index),
    ...doc.content.slice(source.end),
  ];
  const insertion =
    target.index > source.index ? target.end - moved.length : target.index;
  remaining.splice(insertion, 0, ...moved);
  return { ...doc, content: remaining };
}

/** A section's searchable prose, useful to callers that need the exact body
 * rather than just its count. */
export function sectionText(doc: NoteDoc, entry: OutlineEntry): string {
  return flattenDoc({
    type: 'doc',
    content: doc.content.slice(entry.index + 1, entry.end),
  });
}
