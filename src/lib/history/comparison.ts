import { docStats, flattenDoc } from '@/lib/notes/docText';
import type { DocNode, NoteDoc } from '@/lib/schema';

export interface OutlineEntry {
  level: number;
  text: string;
}

export interface ComparedOutlineEntry extends OutlineEntry {
  status: 'added' | 'removed' | 'unchanged';
}

export interface DocumentComparison {
  saved: {
    words: number;
    characters: number;
    sections: number;
  };
  current: {
    words: number;
    characters: number;
    sections: number;
  };
  delta: {
    words: number;
    characters: number;
    sections: number;
    wordPercent: number;
  };
  outline: ComparedOutlineEntry[];
}

export function documentOutline(doc: NoteDoc): OutlineEntry[] {
  const result: OutlineEntry[] = [];
  const visit = (node: DocNode) => {
    if (node.type === 'heading') {
      const text = flattenDoc({ type: 'doc', content: [node] }).trim();
      if (text) {
        result.push({
          level: Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))),
          text,
        });
      }
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of doc.content) visit(node);
  return result;
}

function outlineKey(entry: OutlineEntry): string {
  return `${entry.level}:${entry.text.trim().toLocaleLowerCase()}`;
}

export function compareDocuments(
  savedDoc: NoteDoc,
  currentDoc: NoteDoc,
): DocumentComparison {
  const savedStats = docStats(savedDoc);
  const currentStats = docStats(currentDoc);
  const savedOutline = documentOutline(savedDoc);
  const currentOutline = documentOutline(currentDoc);
  const remainingSaved = new Map<string, number>();
  for (const entry of savedOutline) {
    const key = outlineKey(entry);
    remainingSaved.set(key, (remainingSaved.get(key) ?? 0) + 1);
  }

  const outline: ComparedOutlineEntry[] = currentOutline.map((entry) => {
    const key = outlineKey(entry);
    const available = remainingSaved.get(key) ?? 0;
    if (available > 0) {
      remainingSaved.set(key, available - 1);
      return { ...entry, status: 'unchanged' };
    }
    return { ...entry, status: 'added' };
  });

  for (const entry of savedOutline) {
    const key = outlineKey(entry);
    const available = remainingSaved.get(key) ?? 0;
    if (available > 0) {
      outline.push({ ...entry, status: 'removed' });
      remainingSaved.set(key, available - 1);
    }
  }

  const wordDelta = currentStats.words - savedStats.words;
  return {
    saved: {
      words: savedStats.words,
      characters: savedStats.characters,
      sections: savedOutline.length,
    },
    current: {
      words: currentStats.words,
      characters: currentStats.characters,
      sections: currentOutline.length,
    },
    delta: {
      words: wordDelta,
      characters: currentStats.characters - savedStats.characters,
      sections: currentOutline.length - savedOutline.length,
      wordPercent:
        savedStats.words === 0
          ? currentStats.words > 0
            ? 100
            : 0
          : Math.round((wordDelta / savedStats.words) * 100),
    },
    outline,
  };
}
