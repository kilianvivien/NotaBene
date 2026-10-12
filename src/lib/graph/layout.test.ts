import { describe, expect, it } from 'vitest';
import { createLayout, type LayoutGraph } from './layout';

/** A library-shaped graph: courses of uneven size, a few links inside each
 * course, the odd one across, and most notes linking to nothing. */
function synthetic(count: number, groupCount = 8): LayoutGraph {
  const groups = new Int32Array(count);
  const links: number[] = [];
  for (let node = 0; node < count; node += 1) {
    groups[node] = node % 9 === 0 ? -1 : (node * 7) % groupCount;
    if (node % 3 === 0 && node >= groupCount) links.push(node, node - groupCount);
    if (node % 41 === 0 && node > 50) links.push(node, node - 37);
  }
  return { count, groups, groupCount, links: Uint32Array.from(links) };
}

function settled(graph: LayoutGraph) {
  const layout = createLayout(graph);
  layout.finish();
  return layout;
}

describe('createLayout', () => {
  it('is the same picture every time, however it is sliced', () => {
    const whole = settled(synthetic(400));
    const sliced = createLayout(synthetic(400));
    while (!sliced.advance(0)) {
      // one iteration per call
    }
    expect([...sliced.x]).toEqual([...whole.x]);
    expect([...sliced.y]).toEqual([...whole.y]);
  });

  it('leaves every position finite and no two notes stacked', () => {
    const layout = settled(synthetic(600));
    let closest = Infinity;
    for (let a = 0; a < layout.x.length; a += 1) {
      expect(Number.isFinite(layout.x[a]!) && Number.isFinite(layout.y[a]!)).toBe(true);
      for (let b = a + 1; b < layout.x.length; b += 1) {
        closest = Math.min(
          closest,
          Math.hypot(layout.x[a]! - layout.x[b]!, layout.y[a]! - layout.y[b]!),
        );
      }
    }
    expect(closest).toBeGreaterThan(4);
  });

  it('keeps each course nearer its own centre than any other', () => {
    const graph = synthetic(600, 5);
    const layout = settled(graph);
    const sum = Array.from({ length: 5 }, () => ({ x: 0, y: 0, n: 0 }));
    for (let node = 0; node < graph.count; node += 1) {
      const group = graph.groups[node]!;
      if (group < 0) continue;
      sum[group]!.x += layout.x[node]!;
      sum[group]!.y += layout.y[node]!;
      sum[group]!.n += 1;
    }
    const centres = sum.map((entry) => ({ x: entry.x / entry.n, y: entry.y / entry.n }));
    let home = 0;
    let grouped = 0;
    for (let node = 0; node < graph.count; node += 1) {
      const group = graph.groups[node]!;
      if (group < 0) continue;
      grouped += 1;
      const distances = centres.map((centre) =>
        Math.hypot(layout.x[node]! - centre.x, layout.y[node]! - centre.y),
      );
      if (distances.indexOf(Math.min(...distances)) === group) home += 1;
    }
    expect(home / grouped).toBeGreaterThan(0.9);
  });

  it('pulls linked notes closer than unlinked ones in the same course', () => {
    const graph: LayoutGraph = {
      count: 40,
      groups: new Int32Array(40),
      groupCount: 1,
      links: Uint32Array.from([0, 39]),
    };
    const layout = settled(graph);
    const linked = Math.hypot(layout.x[0]! - layout.x[39]!, layout.y[0]! - layout.y[39]!);
    const before = createLayout(graph);
    const apart = Math.hypot(before.x[0]! - before.x[39]!, before.y[0]! - before.y[39]!);
    expect(linked).toBeLessThan(apart);
  });

  it('warm-started with one more link, moves the picture a little, not wholesale', () => {
    const before = synthetic(300);
    const first = settled(before);
    const after = { ...before, links: Uint32Array.from([...before.links, 5, 250]) };
    const warm = createLayout(after, { x: first.x, y: first.y });
    const gap = () => Math.hypot(warm.x[5]! - warm.x[250]!, warm.y[5]! - warm.y[250]!);
    const apart = gap();
    warm.finish();
    expect(gap()).toBeLessThan(apart);
    let moved = 0;
    for (let node = 0; node < after.count; node += 1) {
      moved += Math.hypot(warm.x[node]! - first.x[node]!, warm.y[node]! - first.y[node]!);
    }
    // On average a note has barely moved; a cold start would deal them all
    // out again from the spiral.
    expect(moved / after.count).toBeLessThan(12);
  });

  it('handles an empty graph and a single note', () => {
    const empty = settled({
      count: 0,
      groups: new Int32Array(0),
      groupCount: 0,
      links: new Uint32Array(0),
    });
    expect(empty.done).toBe(true);
    expect(empty.bounds().width).toBeGreaterThan(0);
    const one = settled({
      count: 1,
      groups: Int32Array.from([-1]),
      groupCount: 0,
      links: new Uint32Array(0),
    });
    expect(one.x[0]).toBeCloseTo(one.bounds().x + one.bounds().width / 2, 0);
  });

  it('settles a 3,000-note library in interactive time', () => {
    const started = performance.now();
    const layout = settled(synthetic(3000, 12));
    const elapsed = performance.now() - started;
    console.info(`graph layout, 3000 notes: ${elapsed.toFixed(0)} ms`);
    expect(layout.done).toBe(true);
    // Generous: this guards against an accidental O(n²), not a slow runner.
    expect(elapsed).toBeLessThan(5000);
  });
});
