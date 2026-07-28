import { MindMapSchema, type MindMap } from '@/lib/schema';

export function mindMapOutline(map: MindMap): string {
  const targets = new Set(map.edges.map((edge) => edge.to));
  const root = map.nodes.find((node) => !targets.has(node.id)) ?? map.nodes[0];
  if (!root) return `# ${map.title}\n`;
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const edge of map.edges) {
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set<string>();
  const lines = [`# ${map.title}`, ''];
  const visit = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    lines.push(`${'  '.repeat(depth)}- ${node.label}${node.note ? ` — ${node.note}` : ''}`);
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };
  visit(root.id, 0);
  for (const node of map.nodes) visit(node.id, 0);
  return `${lines.join('\n')}\n`;
}

/** Remove descendants of collapsed branches from the rendered projection.
 * The source map is never changed, so expanding restores every label and edge. */
export function visibleMindMap(map: MindMap, collapsed: string[]): MindMap {
  if (!collapsed.length) return map;
  const hidden = new Set<string>();
  const children = new Map<string, string[]>();
  for (const edge of map.edges) {
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  }
  const hideChildren = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (hidden.has(child)) continue;
      hidden.add(child);
      hideChildren(child);
    }
  };
  for (const id of collapsed) hideChildren(id);
  return MindMapSchema.parse({
    ...map,
    nodes: map.nodes.filter((node) => !hidden.has(node.id)),
    edges: map.edges.filter((edge) => !hidden.has(edge.from) && !hidden.has(edge.to)),
  });
}

export function reparentMindMap(map: MindMap, nodeId: string, parentId: string): MindMap {
  if (nodeId === parentId) return map;
  const descendants = new Set<string>();
  const visit = (id: string) => {
    for (const edge of map.edges.filter((entry) => entry.from === id)) {
      if (!descendants.has(edge.to)) {
        descendants.add(edge.to);
        visit(edge.to);
      }
    }
  };
  visit(nodeId);
  if (descendants.has(parentId)) return map;
  return MindMapSchema.parse({
    ...map,
    edges: [
      ...map.edges.filter((edge) => edge.to !== nodeId),
      { from: parentId, to: nodeId },
    ],
  });
}
