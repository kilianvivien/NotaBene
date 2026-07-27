/**
 * Mind map layout, and the SVG it produces.
 *
 * Deliberately pure and dependency-free. The same picture has to appear in the
 * editor, in an HTML export, in a PDF and in a DOCX, and the only way to keep
 * those four honest is for all of them to render one string produced here — the
 * `svg` attribute on the node, exactly as `drawing` already works. A layout
 * engine that only ran in the browser would mean a mind map that vanished from
 * every export.
 *
 * The algorithm is a radial tree, not a force simulation. Force layouts look
 * better on a graph nobody has to read twice; a revision aid needs the same
 * note to draw the same way every time it is opened, and determinism is worth
 * more here than elegance.
 */
import type { MindMap } from '@/lib/schema';

export interface LaidOutNode {
  id: string;
  label: string;
  note?: string;
  group?: string;
  /** Distance from the root, in edges. 0 is the root. */
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Wrapped label, one entry per rendered line. */
  lines: string[];
}

export interface LaidOutEdge {
  from: LaidOutNode;
  to: LaidOutNode;
  label?: string;
}

export interface MindMapLayout {
  title: string;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

/** Ring spacing. Wide enough that a two-line label on one ring cannot touch the
 * next, at the font size `renderMindMapSvg` draws with. */
const RING = 132;
const CHARACTERS_PER_LINE = 18;
const LINE_HEIGHT = 15;
const PADDING_X = 12;
const PADDING_Y = 9;
/** Slack around the outermost ring, so a long label at the edge is not clipped
 * by the viewBox. */
const MARGIN = 90;

/** Greedy word wrap. Long single words are broken rather than allowed to run
 * out of their box — a chemical name is still more use truncated than absent. */
function wrap(label: string, limit = CHARACTERS_PER_LINE): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of label.split(/\s+/).filter(Boolean)) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= limit) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
    while (line.length > limit) {
      lines.push(line.slice(0, limit));
      line = line.slice(limit);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines.slice(0, 3) : [''];
}

/**
 * Turn the edge list into a tree.
 *
 * The schema guarantees every edge points at a node that exists, but not that
 * the result is a tree: a model can and does emit a node with two parents, or a
 * cycle. Both are resolved by first-parent-wins during a breadth-first walk,
 * which is stable and never loops. Nodes no edge reaches hang off the root, so
 * a stray node is drawn rather than silently dropped.
 */
function childrenOf(map: MindMap): { rootId: string; children: Map<string, string[]> } {
  const targets = new Set(map.edges.map((edge) => edge.to));
  const rootId =
    map.nodes.find((node) => !targets.has(node.id))?.id ?? map.nodes[0]?.id ?? '';

  const adjacency = new Map<string, string[]>();
  for (const edge of map.edges) {
    if (edge.from === edge.to) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }

  const children = new Map<string, string[]>();
  const claimed = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    const kept: string[] = [];
    for (const child of adjacency.get(current) ?? []) {
      if (claimed.has(child)) continue;
      claimed.add(child);
      kept.push(child);
      queue.push(child);
    }
    if (kept.length) children.set(current, kept);
  }

  const orphans = map.nodes
    .filter((node) => !claimed.has(node.id))
    .map((node) => node.id);
  if (orphans.length) {
    children.set(rootId, [...(children.get(rootId) ?? []), ...orphans]);
  }
  return { rootId, children };
}

export function layoutMindMap(map: MindMap): MindMapLayout {
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const { rootId, children } = childrenOf(map);

  /** Leaves under a node, which is what decides how much angle it gets. A
   * branch with nine sub-topics should not be squeezed into the same wedge as
   * one with a single leaf. */
  const weights = new Map<string, number>();
  const weigh = (id: string): number => {
    const cached = weights.get(id);
    if (cached !== undefined) return cached;
    weights.set(id, 1); // guards against a cycle the BFS above could not see
    const kids = children.get(id) ?? [];
    const total = kids.length ? kids.reduce((sum, kid) => sum + weigh(kid), 0) : 1;
    weights.set(id, total);
    return total;
  };
  weigh(rootId);

  const laidOut = new Map<string, LaidOutNode>();

  const place = (id: string, depth: number, from: number, to: number): void => {
    const source = byId.get(id);
    if (!source || laidOut.has(id)) return;

    const middle = (from + to) / 2;
    const radius = depth * RING;
    const lines = wrap(source.label);
    const longest = lines.reduce((most, line) => Math.max(most, line.length), 0);

    laidOut.set(id, {
      id,
      label: source.label,
      note: source.note,
      group: source.group,
      depth,
      // -π/2 puts the first branch at the top, so a map with two children reads
      // left-and-right rather than as a diagonal.
      x: Math.cos(middle - Math.PI / 2) * radius,
      y: Math.sin(middle - Math.PI / 2) * radius,
      width: longest * 6.6 + PADDING_X * 2,
      height: lines.length * LINE_HEIGHT + PADDING_Y * 2,
      lines,
    });

    const kids = children.get(id) ?? [];
    if (!kids.length) return;
    const span = to - from;
    const total = kids.reduce((sum, kid) => sum + weigh(kid), 0) || 1;
    let cursor = from;
    for (const kid of kids) {
      const slice = (weigh(kid) / total) * span;
      place(kid, depth + 1, cursor, cursor + slice);
      cursor += slice;
    }
  };

  place(rootId, 0, 0, Math.PI * 2);

  const nodes = map.nodes
    .map((node) => laidOut.get(node.id))
    .filter((node): node is LaidOutNode => node !== undefined);

  const edges: LaidOutEdge[] = [];
  for (const [parentId, kids] of children) {
    const parent = laidOut.get(parentId);
    if (!parent) continue;
    for (const kidId of kids) {
      const kid = laidOut.get(kidId);
      if (!kid) continue;
      const declared = map.edges.find(
        (edge) => edge.from === parentId && edge.to === kidId,
      );
      edges.push({ from: parent, to: kid, label: declared?.label });
    }
  }

  const extentX = nodes.reduce(
    (most, node) => Math.max(most, Math.abs(node.x) + node.width / 2),
    RING,
  );
  const extentY = nodes.reduce(
    (most, node) => Math.max(most, Math.abs(node.y) + node.height / 2),
    RING,
  );

  return {
    title: map.title,
    nodes,
    edges,
    width: Math.ceil((extentX + MARGIN) * 2),
    height: Math.ceil((extentY + MARGIN) * 2),
  };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/**
 * Ring colours, by depth.
 *
 * Literal hex rather than `--nb-` tokens: this string is written into the note
 * and then into a PDF and a Word file, neither of which has a stylesheet. The
 * palette is the course-colour one, which is already tuned to read on both the
 * light and the dark paper.
 */
const RING_COLORS = ['#3478c7', '#9b5c2f', '#4b7c58', '#7d5aa8', '#aa4e6e'];

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A quadratic curve that leaves the parent horizontally, which reads as a
 * branch rather than as a wire between two boxes. */
function branchPath(edge: LaidOutEdge): string {
  const midX = (edge.from.x + edge.to.x) / 2;
  return `M ${edge.from.x.toFixed(1)} ${edge.from.y.toFixed(1)} Q ${midX.toFixed(1)} ${edge.from.y.toFixed(1)} ${edge.to.x.toFixed(1)} ${edge.to.y.toFixed(1)}`;
}

/**
 * Render a laid-out map as a standalone SVG document.
 *
 * Self-contained on purpose — no CSS variables, no external fonts, no scripts.
 * The same string has to survive being inlined in an editor, embedded in an
 * exported HTML file, handed to pdfmake, and dropped into a DOCX as an image.
 */
export function renderMindMapSvg(layout: MindMapLayout): string {
  const halfWidth = layout.width / 2;
  const halfHeight = layout.height / 2;

  const paths = layout.edges
    .map((edge) => {
      const color = RING_COLORS[(edge.to.depth - 1) % RING_COLORS.length];
      return `<path d="${branchPath(edge)}" fill="none" stroke="${color}" stroke-opacity="0.55" stroke-width="${Math.max(1.2, 3 - edge.to.depth * 0.6)}" stroke-linecap="round"/>`;
    })
    .join('');

  const labels = layout.edges
    .filter((edge) => edge.label)
    .map((edge) => {
      const x = (edge.from.x + edge.to.x) / 2;
      const y = (edge.from.y + edge.to.y) / 2;
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="9" fill="#6f6b64">${escapeXml(edge.label!)}</text>`;
    })
    .join('');

  const boxes = layout.nodes
    .map((node) => {
      const color = RING_COLORS[Math.max(0, node.depth - 1) % RING_COLORS.length];
      const root = node.depth === 0;
      const x = node.x - node.width / 2;
      const y = node.y - node.height / 2;
      const text = node.lines
        .map(
          (line, index) =>
            `<tspan x="${node.x.toFixed(1)}" dy="${index === 0 ? 0 : LINE_HEIGHT}">${escapeXml(line)}</tspan>`,
        )
        .join('');
      const first = node.y - node.height / 2 + PADDING_Y + 11;

      return (
        `<g>` +
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${node.width.toFixed(1)}" height="${node.height.toFixed(1)}" rx="${root ? 9 : 7}" ` +
        `fill="${root ? color : '#ffffff'}" stroke="${color}" stroke-width="${root ? 0 : 1.3}"/>` +
        `<text x="${node.x.toFixed(1)}" y="${first.toFixed(1)}" text-anchor="middle" font-size="11.5" ` +
        `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" ` +
        `font-weight="${root ? 600 : 400}" fill="${root ? '#ffffff' : '#1c1b19'}">${text}</text>` +
        `</g>`
      );
    })
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-halfWidth} ${-halfHeight} ${layout.width} ${layout.height}" ` +
    `width="${layout.width}" height="${layout.height}" role="img" aria-label="${escapeXml(layout.title)}">` +
    `<rect x="${-halfWidth}" y="${-halfHeight}" width="${layout.width}" height="${layout.height}" fill="#fbfaf8"/>` +
    paths +
    labels +
    boxes +
    `</svg>`
  );
}

export function mindMapToSvg(map: MindMap): string {
  return renderMindMapSvg(layoutMindMap(map));
}
