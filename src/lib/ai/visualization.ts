/** Render the selected structure mechanically. The model decides what earns
 * a place and how it relates; it need not also invent ids or Mermaid syntax. */
import type {
  AiDiagramPlan,
  AiMindMapPlan,
  DocNode,
  MindMap,
  NoteDoc,
} from '@/lib/schema';
import { docToMarkdown } from '@/editor/markdown';

/** Existing pictures carry scene JSON and SVG, not source prose. Sending them
 * back makes regeneration imitate the old picture and can exhaust the context. */
export function visualizationMarkdown(doc: NoteDoc): string {
  function source(node: DocNode): DocNode[] {
    if (node.type === 'mindMap' || node.type === 'drawing') return [];
    return [
      { ...node, ...(node.content ? { content: node.content.flatMap(source) } : {}) },
    ];
  }
  return docToMarkdown({ type: 'doc', content: doc.content.flatMap(source) });
}

export function plannedMindMap(plan: AiMindMapPlan): MindMap {
  const map: MindMap = {
    title: plan.title,
    nodes: [{ id: 'root', label: plan.root, note: plan.takeaway }],
    edges: [],
  };
  plan.branches.forEach((branch, index) => {
    const id = `branch-${index}`;
    map.nodes.push({ id, label: branch.label, note: branch.note });
    map.edges.push({ from: 'root', to: id });
    branch.children.forEach((child, childIndex) => {
      const childId = `${id}-${childIndex}`;
      map.nodes.push({ id: childId, ...child });
      map.edges.push({ from: id, to: childId });
    });
  });
  return map;
}

/** Mermaid's numeric entities keep text from becoming syntax, including in
 * sequence messages where quotes do not delimit a label. */
function mermaidLabel(value: string): string {
  return value
    .replace(/\s+/gu, ' ')
    .replace(/[#&"<>|:;`[\]{}()\\]/gu, (character) => `#${character.charCodeAt(0)};`);
}

export function plannedMermaid(plan: AiDiagramPlan): string {
  const ids = new Map(plan.nodes.map((node, index) => [node.id, `n${index}`]));
  const id = (value: string) => ids.get(value)!;
  if (plan.kind === 'sequence') {
    return [
      'sequenceDiagram',
      ...plan.nodes.map(
        (node) => `  participant ${id(node.id)} as ${mermaidLabel(node.label)}`,
      ),
      ...plan.edges.map(
        (edge) => `  ${id(edge.from)}->>${id(edge.to)}: ${mermaidLabel(edge.label)}`,
      ),
    ].join('\n');
  }
  return [
    `flowchart ${plan.direction}`,
    ...plan.nodes.map((node) => {
      const text = `"${mermaidLabel(node.label)}"`;
      return `  ${id(node.id)}${node.shape === 'decision' ? `{${text}}` : `[${text}]`}`;
    }),
    ...plan.edges.map(
      (edge) => `  ${id(edge.from)} -->|"${mermaidLabel(edge.label)}"| ${id(edge.to)}`,
    ),
  ].join('\n');
}
