/**
 * Which part of the library the graph view draws.
 *
 * Pure: the filters, the ceiling and the index the layout and the canvas read
 * are all decided here, away from React, so they can be tested without a DOM.
 */
import type { GraphEdge, GraphNode, LibraryGraph } from '@/lib/schema';
import type { LayoutGraph } from './layout';

/**
 * The most notes drawn at once.
 *
 * Not a performance limit. On a synthetic 3,000-note library the layout
 * settles in about 350 ms and 6,000 in about a second (Chromium, an Apple
 * silicon laptop, 2026-10-12; the desktop WebKit build was not measured). It
 * is a legibility one: fitted to a laptop window, 2,500 notes already sit five
 * or six pixels apart, and past that the dots touch. So above the ceiling the
 * view filters instead of rendering a hairball — notes with no links go
 * first, then the least connected — and it says so.
 */
export const NODE_CEILING = 2500;

export type GraphSince = 'any' | 'week' | 'month' | 'term' | 'year';

const SINCE_DAYS: Record<Exclude<GraphSince, 'any'>, number> = {
  week: 7,
  month: 30,
  // A semester, near enough: long enough to hold a course, short enough to
  // leave last year's out.
  term: 120,
  year: 365,
};

/** `all`, `inbox` (notes in no course), or `course:{id}`. */
export type GraphCourseFilter = 'all' | 'inbox' | `course:${string}`;

export interface GraphFilters {
  course: GraphCourseFilter;
  tagId: string | null;
  since: GraphSince;
  /** Hide notes that nothing links to or from. */
  linkedOnly: boolean;
  /** Draw unlinked mentions as dashed edges. */
  mentions: boolean;
}

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  course: 'all',
  tagId: null,
  since: 'any',
  linkedOnly: false,
  mentions: false,
};

export interface GraphSelection {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mentions: GraphEdge[];
  /** Notes that passed the filters, before the ceiling. */
  matching: number;
  /** What the ceiling removed, if anything. */
  trimmed: 'none' | 'unlinked' | 'leastLinked';
}

function within(edges: GraphEdge[], kept: Set<string>): GraphEdge[] {
  return edges.filter((edge) => kept.has(edge.sourceId) && kept.has(edge.targetId));
}

function degrees(edges: GraphEdge[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const edge of edges) {
    count.set(edge.sourceId, (count.get(edge.sourceId) ?? 0) + 1);
    count.set(edge.targetId, (count.get(edge.targetId) ?? 0) + 1);
  }
  return count;
}

export function selectGraph(
  graph: LibraryGraph,
  filters: GraphFilters,
  now: number = Date.now(),
  ceiling: number = NODE_CEILING,
): GraphSelection {
  const cutoff =
    filters.since === 'any'
      ? null
      : new Date(now - SINCE_DAYS[filters.since] * 86_400_000).toISOString();
  const courseId = filters.course.startsWith('course:')
    ? filters.course.slice('course:'.length)
    : null;

  let nodes = graph.nodes.filter((node) => {
    if (filters.course === 'inbox' && node.courseId !== null) return false;
    if (courseId !== null && node.courseId !== courseId) return false;
    if (filters.tagId !== null && !node.tagIds.includes(filters.tagId)) return false;
    if (cutoff !== null && node.updatedAt < cutoff) return false;
    return true;
  });

  const shownMentions = filters.mentions ? graph.mentions : [];
  let kept = new Set(nodes.map((node) => node.id));
  // A mention counts as a connection while mentions are on screen: hiding the
  // note at one end of a dashed line would hide the suggestion with it.
  const degree = degrees([...within(graph.edges, kept), ...within(shownMentions, kept)]);

  if (filters.linkedOnly) {
    nodes = nodes.filter((node) => degree.has(node.id));
  }
  const matching = nodes.length;

  let trimmed: GraphSelection['trimmed'] = 'none';
  if (nodes.length > ceiling) {
    const linked = nodes.filter((node) => degree.has(node.id));
    if (linked.length < nodes.length) {
      nodes = linked;
      trimmed = 'unlinked';
    }
    if (nodes.length > ceiling) {
      nodes = [...nodes]
        .sort(
          (a, b) =>
            (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
            b.updatedAt.localeCompare(a.updatedAt) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, ceiling);
      trimmed = 'leastLinked';
    }
  }

  kept = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: within(graph.edges, kept),
    mentions: within(shownMentions, kept),
    matching,
    trimmed,
  };
}

/** A selection as the arrays the layout and the canvas index into. */
export interface GraphIndex extends LayoutGraph {
  nodes: GraphNode[];
  /** Course id per group index. */
  groupIds: string[];
  /** Unlinked mentions as flattened index pairs; not part of the layout. */
  mentionLinks: Uint32Array;
  /** Links touching each node — what its size is drawn from. */
  degree: Uint16Array;
  /** Notes one link away, in either direction, mentions included. */
  neighbours: number[][];
  indexOf: Map<string, number>;
}

function pairs(edges: GraphEdge[], indexOf: Map<string, number>): Uint32Array {
  const flat = new Uint32Array(edges.length * 2);
  edges.forEach((edge, position) => {
    flat[position * 2] = indexOf.get(edge.sourceId)!;
    flat[position * 2 + 1] = indexOf.get(edge.targetId)!;
  });
  return flat;
}

/**
 * `courseOrder` is the sidebar's order, so a course keeps its place on the
 * ring whichever notes a filter leaves in it.
 */
export function indexGraph(selection: GraphSelection, courseOrder: string[]): GraphIndex {
  const { nodes } = selection;
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
  const present = new Set(nodes.map((node) => node.courseId));
  const groupIds = [
    ...courseOrder.filter((id) => present.has(id)),
    // A course the cache has not heard of yet still gets a cluster.
    ...[...present]
      .filter((id): id is string => id !== null && !courseOrder.includes(id))
      .sort(),
  ];
  const groupOf = new Map(groupIds.map((id, index) => [id, index]));
  const groups = new Int32Array(nodes.length);
  nodes.forEach((node, index) => {
    groups[index] = node.courseId === null ? -1 : (groupOf.get(node.courseId) ?? -1);
  });

  const links = pairs(selection.edges, indexOf);
  const mentionLinks = pairs(selection.mentions, indexOf);
  const degree = new Uint16Array(nodes.length);
  const neighbours: number[][] = nodes.map(() => []);
  for (const flat of [links, mentionLinks]) {
    for (let link = 0; link < flat.length; link += 2) {
      const source = flat[link]!;
      const target = flat[link + 1]!;
      if (flat === links) {
        degree[source]! += 1;
        degree[target]! += 1;
      }
      if (!neighbours[source]!.includes(target)) neighbours[source]!.push(target);
      if (!neighbours[target]!.includes(source)) neighbours[target]!.push(source);
    }
  }

  return {
    nodes,
    count: nodes.length,
    groups,
    groupCount: groupIds.length,
    groupIds,
    links,
    mentionLinks,
    degree,
    neighbours,
    indexOf,
  };
}
