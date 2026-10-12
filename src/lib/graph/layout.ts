/**
 * Where each note sits in the graph view.
 *
 * A force-directed layout, with three properties the view depends on:
 *
 * - **Deterministic.** No random numbers anywhere: notes start on a spiral
 *   around their course's anchor, and the same library always settles into the
 *   same picture. A graph that rearranges itself every time it is opened
 *   cannot be learned.
 * - **Clustered by course.** A student's library is mostly notes that link to
 *   nothing, and pure link forces would leave them in one grey cloud. Each
 *   course gets an anchor on a ring and its notes are drawn toward it, so the
 *   picture reads as courses first and links second. Notes without a course
 *   take the centre.
 * - **Sliced.** `advance` runs iterations until a time budget is spent, so the
 *   view can draw the layout settling instead of freezing while it does. The
 *   result does not depend on how it was sliced — only the iteration count
 *   decides it.
 *
 * Repulsion is short-range, through a uniform grid, rather than Barnes–Hut.
 * The anchors already hold the global shape, so nothing far away needs to push
 * on anything; what is left is keeping neighbours from stacking, which only
 * ever involves the cells around a node.
 */

export interface LayoutGraph {
  count: number;
  /** Group (course) index per node, or -1 for none. */
  groups: Int32Array;
  groupCount: number;
  /** Links as flattened index pairs: source, target, source, target… */
  links: Uint32Array;
}

export interface LayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLayout {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly done: boolean;
  /** Run iterations for up to `budgetMs`, always at least one. True when settled. */
  advance(budgetMs: number): boolean;
  /** Run to the end. For tests and for libraries small enough not to notice. */
  finish(): void;
  bounds(): LayoutBounds;
}

export const LAYOUT_ITERATIONS = 300;

const SPACING = 26;
const GROUP_GAP = 90;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const LINK_DISTANCE = 48;
const REPULSION = 70;
const REPEL_RANGE = 150;
const ANCHOR_STRENGTH = 0.045;
const VELOCITY_KEEP = 0.6;
const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / LAYOUT_ITERATIONS);
const BOUNDS_PADDING = 40;

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** How hot a warm-started layout begins: enough to absorb one new link,
 * not enough to throw the picture the student was looking at. */
const WARM_ALPHA = 0.25;

/**
 * `warm` starts every note where an earlier layout of the *same notes* left
 * it, and starts cool. It is for a link added while the graph is open: the
 * two notes drift together instead of the whole library being dealt out
 * again. The picture it settles into is then a continuation of the one on
 * screen, not the canonical one — reopening the graph gives that.
 */
export function createLayout(
  graph: LayoutGraph,
  warm?: { x: Float32Array; y: Float32Array },
): GraphLayout {
  const { count, groups, groupCount, links } = graph;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const vx = new Float32Array(count);
  const vy = new Float32Array(count);
  const anchorX = new Float32Array(count);
  const anchorY = new Float32Array(count);
  const degree = new Uint32Array(count);
  for (let link = 0; link < links.length; link += 2) {
    degree[links[link]!]! += 1;
    degree[links[link + 1]!]! += 1;
  }

  // -- anchors and starting positions --------------------------------------
  // Slot 0 is "no course", at the centre; courses follow on a ring sized so
  // that their starting discs do not overlap.
  const sizes = new Uint32Array(groupCount + 1);
  for (let node = 0; node < count; node += 1) sizes[groups[node]! + 1]! += 1;
  const radius = (size: number) => SPACING * Math.sqrt(size);
  let perimeter = 0;
  let widest = 0;
  for (let group = 1; group <= groupCount; group += 1) {
    const r = radius(sizes[group]!);
    perimeter += 2 * r + GROUP_GAP;
    widest = Math.max(widest, r);
  }
  const occupied = sizes.filter((size, slot) => slot > 0 && size > 0).length;
  const loose = sizes[0]! > 0;
  const ring =
    occupied === 0 || (occupied === 1 && !loose)
      ? 0
      : Math.max(perimeter / (2 * Math.PI), radius(sizes[0]!) + widest + GROUP_GAP);
  const centreX = new Float32Array(groupCount + 1);
  const centreY = new Float32Array(groupCount + 1);
  let travelled = 0;
  for (let group = 1; group <= groupCount; group += 1) {
    const arc = 2 * radius(sizes[group]!) + GROUP_GAP;
    // Start at twelve o'clock and go clockwise, the order the sidebar lists
    // courses in.
    const angle = ((travelled + arc / 2) / (perimeter || 1)) * 2 * Math.PI - Math.PI / 2;
    centreX[group] = ring * Math.cos(angle);
    centreY[group] = ring * Math.sin(angle);
    travelled += arc;
  }
  const placed = new Uint32Array(groupCount + 1);
  for (let node = 0; node < count; node += 1) {
    const slot = groups[node]! + 1;
    const rank = placed[slot]!;
    placed[slot] = rank + 1;
    const r = SPACING * Math.sqrt(rank + 0.5);
    const angle = rank * GOLDEN_ANGLE;
    anchorX[node] = centreX[slot]!;
    anchorY[node] = centreY[slot]!;
    x[node] = centreX[slot]! + r * Math.cos(angle);
    y[node] = centreY[slot]! + r * Math.sin(angle);
  }

  // -- the grid neighbours are found through -------------------------------
  const cellOf = new Int32Array(count);
  const order = new Uint32Array(count);
  let starts = new Uint32Array(1);

  function repel(alpha: number): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let node = 0; node < count; node += 1) {
      if (x[node]! < minX) minX = x[node]!;
      if (x[node]! > maxX) maxX = x[node]!;
      if (y[node]! < minY) minY = y[node]!;
      if (y[node]! > maxY) maxY = y[node]!;
    }
    const columns = Math.floor((maxX - minX) / REPEL_RANGE) + 1;
    const rows = Math.floor((maxY - minY) / REPEL_RANGE) + 1;
    const cells = columns * rows;
    if (starts.length < cells + 1) starts = new Uint32Array(cells + 1);
    else starts.fill(0, 0, cells + 1);
    for (let node = 0; node < count; node += 1) {
      const cell =
        Math.floor((y[node]! - minY) / REPEL_RANGE) * columns +
        Math.floor((x[node]! - minX) / REPEL_RANGE);
      cellOf[node] = cell;
      starts[cell + 1]! += 1;
    }
    for (let cell = 0; cell < cells; cell += 1) starts[cell + 1]! += starts[cell]!;
    const cursor = starts.slice(0, cells);
    for (let node = 0; node < count; node += 1) {
      const cell = cellOf[node]!;
      order[cursor[cell]!] = node;
      cursor[cell]! += 1;
    }

    const range2 = REPEL_RANGE * REPEL_RANGE;
    const strength = REPULSION * alpha;
    for (let node = 0; node < count; node += 1) {
      const cell = cellOf[node]!;
      const column = cell % columns;
      const row = (cell - column) / columns;
      for (let dy = -1; dy <= 1; dy += 1) {
        const otherRow = row + dy;
        if (otherRow < 0 || otherRow >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const otherColumn = column + dx;
          if (otherColumn < 0 || otherColumn >= columns) continue;
          const other = otherRow * columns + otherColumn;
          for (let slot = starts[other]!; slot < starts[other + 1]!; slot += 1) {
            const peer = order[slot]!;
            // Each pair once, from the lower index.
            if (peer <= node) continue;
            let offsetX = x[peer]! - x[node]!;
            let offsetY = y[peer]! - y[node]!;
            let distance2 = offsetX * offsetX + offsetY * offsetY;
            if (distance2 >= range2) continue;
            if (distance2 < 1e-6) {
              // Two notes on the same spot have no direction to part in. Give
              // them one from their indices — arbitrary, but the same one
              // every run.
              offsetX = (((node * 7 + peer * 13) % 11) - 5) * 0.01 + 0.005;
              offsetY = (((node * 3 + peer * 17) % 7) - 3) * 0.01 + 0.005;
              distance2 = offsetX * offsetX + offsetY * offsetY;
            }
            // Floored so two notes that start almost touching are pushed
            // apart firmly instead of fired across the canvas.
            const push = strength / Math.max(distance2, 16);
            vx[node]! -= offsetX * push;
            vy[node]! -= offsetY * push;
            vx[peer]! += offsetX * push;
            vy[peer]! += offsetY * push;
          }
        }
      }
    }
  }

  function pull(alpha: number): void {
    for (let link = 0; link < links.length; link += 2) {
      const source = links[link]!;
      const target = links[link + 1]!;
      let offsetX = x[target]! + vx[target]! - x[source]! - vx[source]!;
      let offsetY = y[target]! + vy[target]! - y[source]! - vy[source]!;
      const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY) || 0.01;
      // A hub's links are each weaker, or a note with forty backlinks would
      // collapse them all onto itself.
      const weight = 1 / Math.min(degree[source]!, degree[target]!);
      const stretch = ((distance - LINK_DISTANCE) / distance) * alpha * weight;
      offsetX *= stretch;
      offsetY *= stretch;
      // The better-connected end moves less.
      const bias = degree[source]! / (degree[source]! + degree[target]!);
      vx[target]! -= offsetX * bias;
      vy[target]! -= offsetY * bias;
      vx[source]! += offsetX * (1 - bias);
      vy[source]! += offsetY * (1 - bias);
    }
  }

  let alpha = 1;
  let iteration = 0;
  if (warm && warm.x.length === count && warm.y.length === count) {
    x.set(warm.x);
    y.set(warm.y);
    alpha = WARM_ALPHA;
    // Skip the iterations a cold start would have spent cooling to here.
    iteration = Math.round(Math.log(WARM_ALPHA) / Math.log(1 - ALPHA_DECAY));
  }

  function tick(): void {
    alpha += (0 - alpha) * ALPHA_DECAY;
    repel(alpha);
    pull(alpha);
    const hold = ANCHOR_STRENGTH * alpha;
    for (let node = 0; node < count; node += 1) {
      vx[node] = (vx[node]! + (anchorX[node]! - x[node]!) * hold) * VELOCITY_KEEP;
      vy[node] = (vy[node]! + (anchorY[node]! - y[node]!) * hold) * VELOCITY_KEEP;
      x[node]! += vx[node]!;
      y[node]! += vy[node]!;
    }
    iteration += 1;
  }

  const layout: GraphLayout = {
    x,
    y,
    get done() {
      return count === 0 || iteration >= LAYOUT_ITERATIONS;
    },
    advance(budgetMs) {
      const started = now();
      while (!layout.done) {
        tick();
        if (now() - started >= budgetMs) break;
      }
      return layout.done;
    },
    finish() {
      while (!layout.done) tick();
    },
    bounds() {
      if (count === 0) return { x: 0, y: 0, width: 1, height: 1 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let node = 0; node < count; node += 1) {
        if (x[node]! < minX) minX = x[node]!;
        if (x[node]! > maxX) maxX = x[node]!;
        if (y[node]! < minY) minY = y[node]!;
        if (y[node]! > maxY) maxY = y[node]!;
      }
      return {
        x: minX - BOUNDS_PADDING,
        y: minY - BOUNDS_PADDING,
        width: maxX - minX + BOUNDS_PADDING * 2,
        height: maxY - minY + BOUNDS_PADDING * 2,
      };
    },
  };
  return layout;
}
