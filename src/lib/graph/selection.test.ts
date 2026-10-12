import { describe, expect, it } from 'vitest';
import type { LibraryGraph } from '@/lib/schema';
import { DEFAULT_GRAPH_FILTERS, indexGraph, selectGraph } from './selection';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');

function node(id: string, courseId: string | null, daysAgo = 1, tagIds: string[] = []) {
  return {
    id,
    title: id,
    courseId,
    tagIds,
    updatedAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  };
}

const GRAPH: LibraryGraph = {
  nodes: [
    node('a', 'physics', 1, ['exam']),
    node('b', 'physics', 40),
    node('c', 'maths', 2),
    node('d', null, 3),
    node('e', null, 400),
  ],
  edges: [
    { sourceId: 'a', targetId: 'b' },
    { sourceId: 'c', targetId: 'a' },
  ],
  mentions: [{ sourceId: 'd', targetId: 'c' }],
};

const ids = (nodes: { id: string }[]) => nodes.map((entry) => entry.id);

describe('selectGraph', () => {
  it('draws everything by default, without the mentions', () => {
    const selection = selectGraph(GRAPH, DEFAULT_GRAPH_FILTERS, NOW);
    expect(ids(selection.nodes)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(selection.edges).toHaveLength(2);
    expect(selection.mentions).toEqual([]);
    expect(selection.trimmed).toBe('none');
  });

  it('filters by course, the inbox, tag and date, dropping edges that lose an end', () => {
    const by = (filters: Partial<typeof DEFAULT_GRAPH_FILTERS>) =>
      selectGraph(GRAPH, { ...DEFAULT_GRAPH_FILTERS, ...filters }, NOW);
    const physics = by({ course: 'course:physics' });
    expect(ids(physics.nodes)).toEqual(['a', 'b']);
    expect(physics.edges).toEqual([{ sourceId: 'a', targetId: 'b' }]);
    expect(ids(by({ course: 'inbox' }).nodes)).toEqual(['d', 'e']);
    expect(ids(by({ tagId: 'exam' }).nodes)).toEqual(['a']);
    expect(ids(by({ since: 'month' }).nodes)).toEqual(['a', 'c', 'd']);
  });

  it('counts a mention as a connection only while mentions are shown', () => {
    const linked = selectGraph(
      GRAPH,
      { ...DEFAULT_GRAPH_FILTERS, linkedOnly: true },
      NOW,
    );
    expect(ids(linked.nodes)).toEqual(['a', 'b', 'c']);
    const withMentions = selectGraph(
      GRAPH,
      { ...DEFAULT_GRAPH_FILTERS, linkedOnly: true, mentions: true },
      NOW,
    );
    expect(ids(withMentions.nodes)).toEqual(['a', 'b', 'c', 'd']);
    expect(withMentions.mentions).toHaveLength(1);
  });

  it('above the ceiling, drops unlinked notes first and says so', () => {
    const selection = selectGraph(GRAPH, DEFAULT_GRAPH_FILTERS, NOW, 4);
    expect(ids(selection.nodes)).toEqual(['a', 'b', 'c']);
    expect(selection.matching).toBe(5);
    expect(selection.trimmed).toBe('unlinked');
  });

  it('then keeps the most connected, and only edges between what is left', () => {
    const selection = selectGraph(GRAPH, DEFAULT_GRAPH_FILTERS, NOW, 2);
    // `a` has two links; `c` beats `b` on recency.
    expect(ids(selection.nodes)).toEqual(['a', 'c']);
    expect(selection.edges).toEqual([{ sourceId: 'c', targetId: 'a' }]);
    expect(selection.trimmed).toBe('leastLinked');
  });
});

describe('indexGraph', () => {
  it('groups by course in the sidebar order and indexes links both ways', () => {
    const selection = selectGraph(
      GRAPH,
      { ...DEFAULT_GRAPH_FILTERS, mentions: true },
      NOW,
    );
    const index = indexGraph(selection, ['maths', 'physics', 'unused']);
    expect(index.groupIds).toEqual(['maths', 'physics']);
    expect([...index.groups]).toEqual([1, 1, 0, -1, -1]);
    expect([...index.links]).toEqual([0, 1, 2, 0]);
    expect([...index.mentionLinks]).toEqual([3, 2]);
    // Size comes from real links; a mention is a neighbour but not a link.
    expect([...index.degree]).toEqual([2, 1, 1, 0, 0]);
    expect(index.neighbours[2]).toEqual([0, 3]);
  });
});
