import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiTransport } from '@/lib/adapters';
import { AiDiagramPlanSchema, AiMindMapPlanSchema, MindMapSchema } from '@/lib/schema';
import { layoutMindMap } from '@/lib/mindmap/layout';
import { markdownToDoc } from '@/editor/markdown';
import { requestMindMap } from './mindmap';
import { requestDiagram } from './diagram';
import { providerById } from './providers';
import { plannedMermaid, plannedMindMap, visualizationMarkdown } from './visualization';
import { MermaidParseError } from '@/lib/diagram/mermaid';
import {
  MEMORY_NOTE,
  MEMORY_PLAN,
  SHORT_NOTE,
  SHORT_PLAN,
  THERMOSTAT_NOTE,
  THERMOSTAT_PLAN,
} from './fixtures/visualization';

const conversion = vi.hoisted(() => vi.fn());
vi.mock('@/lib/diagram/mermaid', async (original) => ({
  ...(await original<typeof import('@/lib/diagram/mermaid')>()),
  mermaidToDrawing: conversion,
}));
const provider = {
  definition: providerById('ollama')!,
  baseUrl: 'http://localhost:11434/v1',
  apiKey: null,
  model: 'test',
};
function answered(plan: unknown) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  conversion.mockReset();
});

describe('editorial visualization plans', () => {
  it('reads the prose without feeding existing diagram payloads back to the model', () => {
    const doc = markdownToDoc(MEMORY_NOTE.markdown);
    doc.content.push({
      type: 'blockquote',
      content: [
        { type: 'mindMap', attrs: { svg: 'old-map-payload', data: MEMORY_PLAN } },
        { type: 'drawing', attrs: { svg: 'old-drawing-payload', data: {} } },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Keep this explanation.' }],
        },
      ],
    });
    const source = visualizationMarkdown(doc);
    expect(source).toContain('Keep this explanation.');
    expect(source).toContain('mémoire de travail');
    expect(source).not.toContain('old-map-payload');
    expect(source).not.toContain('notabene-drawing');
    expect(source).not.toContain('notabene-mindmap');
  });

  it('rejects duplicate concepts and a third level instead of dropping leaves', () => {
    expect(
      AiMindMapPlanSchema.safeParse({
        ...MEMORY_PLAN,
        branches: [MEMORY_PLAN.branches[0], MEMORY_PLAN.branches[0]],
      }).success,
    ).toBe(false);
    expect(
      AiMindMapPlanSchema.safeParse({
        ...MEMORY_PLAN,
        branches: [
          {
            label: 'Branch',
            children: [{ label: 'Child', children: [{ label: 'Hidden leaf' }] }],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('turns a dense note into a shallow tree with qualifications outside the labels', async () => {
    const transport = vi
      .spyOn(aiTransport, 'request')
      .mockResolvedValue(answered(MEMORY_PLAN));
    const result = await requestMindMap({
      provider,
      source: { title: MEMORY_NOTE.title, doc: markdownToDoc(MEMORY_NOTE.markdown) },
      language: 'fr',
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(MindMapSchema.safeParse(result.map).success).toBe(true);
    expect(result.map.nodes).toHaveLength(12);
    expect(Math.max(...layoutMindMap(result.map).nodes.map((node) => node.depth))).toBe(
      2,
    );
    expect(result.map.nodes.some((node) => node.note?.includes('limitée'))).toBe(true);
    expect(
      new DOMParser().parseFromString(result.svg, 'image/svg+xml').documentElement
        .textContent,
    ).toContain('Restitutiondurable');
    expect(result.editorial?.omitted).toHaveLength(3);
  });

  it('rejects an exhaustive map and repairs it without silently pruning concepts', async () => {
    const crowded = {
      ...MEMORY_PLAN,
      branches: Array.from({ length: 5 }, (_, i) => ({
        label: `Branch ${i}`,
        children: Array.from({ length: 3 }, (_, j) => ({ label: `Detail ${i}-${j}` })),
      })),
    };
    expect(AiMindMapPlanSchema.safeParse(crowded).success).toBe(false);
    const transport = vi
      .spyOn(aiTransport, 'request')
      .mockResolvedValueOnce(answered(crowded))
      .mockResolvedValueOnce(answered(MEMORY_PLAN));
    const result = await requestMindMap({
      provider,
      source: { title: MEMORY_NOTE.title, doc: markdownToDoc(MEMORY_NOTE.markdown) },
      language: 'fr',
    });
    expect(result.map.nodes).toHaveLength(12);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(String(transport.mock.calls[1]?.[0].body)).toContain('at most 18 nodes');
  });

  it('preserves a decision, convergence and feedback instead of forcing a tree', async () => {
    vi.spyOn(aiTransport, 'request').mockResolvedValue(answered(THERMOSTAT_PLAN));
    conversion.mockResolvedValue({
      svg: '<svg/>',
      data: { elements: [], appState: {}, files: {} },
    });
    const result = await requestDiagram({
      provider,
      source: {
        title: THERMOSTAT_NOTE.title,
        doc: markdownToDoc(THERMOSTAT_NOTE.markdown),
      },
      language: 'fr',
    });
    expect(conversion).toHaveBeenCalledWith(result.answer.mermaid);
    expect(result.answer.mermaid).toContain('n2{"Température sous la consigne ?"}');
    expect(result.answer.mermaid).toContain('n0 -->|"température mesurée"| n2');
    expect(result.answer.mermaid).toContain('n1 -->|"valeur de référence"| n2');
    expect(result.answer.mermaid).toContain('n5 -->|"est mesurée en continu"| n0');
    expect(result.editorial?.takeaway).toBe(THERMOSTAT_PLAN.takeaway);
  });

  it('accepts a three-step note without padding it to a target size', () => {
    const plan = AiDiagramPlanSchema.parse(SHORT_PLAN);
    expect(plannedMermaid(plan).split('\n')).toHaveLength(6);
    expect(plan.nodes).toHaveLength(3);
    expect(SHORT_NOTE.markdown).toContain('reviewer');
  });

  it('revises a rejected diagram plan once and retains the editorial focus', async () => {
    const transport = vi
      .spyOn(aiTransport, 'request')
      .mockResolvedValue(answered(SHORT_PLAN));
    conversion
      .mockRejectedValueOnce(new MermaidParseError('conversion rejected'))
      .mockResolvedValueOnce({
        svg: '<svg/>',
        data: { elements: [], appState: {}, files: {} },
      });
    const result = await requestDiagram({
      provider,
      source: { title: SHORT_NOTE.title, doc: markdownToDoc(SHORT_NOTE.markdown) },
      language: 'en',
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(String(transport.mock.calls[1]?.[0].body)).toContain('conversion rejected');
    expect(result.editorial?.focus).toBe(SHORT_PLAN.focus);
  });

  it('rejects missing endpoints, duplicate ids and unrelated boxes', () => {
    expect(
      AiDiagramPlanSchema.safeParse({
        ...SHORT_PLAN,
        edges: [{ from: 'submit', to: 'missing', label: 'then' }],
      }).success,
    ).toBe(false);
    expect(
      AiDiagramPlanSchema.safeParse({
        ...SHORT_PLAN,
        nodes: [...SHORT_PLAN.nodes, SHORT_PLAN.nodes[0]],
      }).success,
    ).toBe(false);
    expect(
      AiDiagramPlanSchema.safeParse({
        ...SHORT_PLAN,
        nodes: [...SHORT_PLAN.nodes, { id: 'aside', label: 'Unrelated', shape: 'box' }],
      }).success,
    ).toBe(false);
  });

  it('keeps model-provided ids and label punctuation out of Mermaid syntax', () => {
    const plan = AiDiagramPlanSchema.parse({
      ...SHORT_PLAN,
      nodes: SHORT_PLAN.nodes.map((node, i) =>
        i === 0 ? { ...node, id: 'end; click evil', label: 'Form "A" < B & C' } : node,
      ),
      edges: SHORT_PLAN.edges.map((edge, i) =>
        i === 0 ? { ...edge, from: 'end; click evil', label: 'then | "review"' } : edge,
      ),
    });
    const source = plannedMermaid(plan);
    expect(source).not.toContain('click evil');
    expect(source).toContain('Form #34;A#34; #60; B #38; C');
    expect(source).toContain('then #124; #34;review#34;');
  });

  it('preserves sequence message order, including repeated exchanges', () => {
    const plan = AiDiagramPlanSchema.parse({
      ...SHORT_PLAN,
      kind: 'sequence',
      nodes: SHORT_PLAN.nodes.slice(0, 2),
      edges: [
        { from: 'submit', to: 'review', label: 'Submit form' },
        { from: 'review', to: 'submit', label: 'Request correction: name; date' },
        { from: 'submit', to: 'review', label: 'Send corrected form' },
      ],
    });
    expect(plannedMermaid(plan)).toContain(
      'n1->>n0: Request correction#58; name#59; date\n  n0->>n1: Send corrected form',
    );
  });

  it('does not send a cancelled run for another model call', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.spyOn(aiTransport, 'request');
    await expect(
      requestMindMap(
        {
          provider,
          source: { title: MEMORY_NOTE.title, doc: markdownToDoc(MEMORY_NOTE.markdown) },
          language: 'fr',
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not constrain larger saved or manually edited maps', () => {
    const map = plannedMindMap(MEMORY_PLAN);
    for (let i = 0; i < 20; i++) {
      map.nodes.push({ id: `extra-${i}`, label: `Extra ${i}` });
      map.edges.push({ from: 'root', to: `extra-${i}` });
    }
    expect(MindMapSchema.safeParse(map).success).toBe(true);
  });
});
