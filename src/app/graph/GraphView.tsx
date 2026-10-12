/**
 * The library as one canvas.
 *
 * Every live note is a dot, coloured by its course; every wiki link is a
 * line. It is navigation rather than an ornament: clicking a note opens it.
 *
 * Decisions worth keeping:
 *
 * - **A `<canvas>`, not SVG or DOM nodes.** A few thousand circles and lines
 *   redrawn on every pan is nothing to a canvas and a great deal to a layout
 *   engine. The cost is that a canvas says nothing to a screen reader or a
 *   keyboard, which is what the find field is for: its results are ordinary
 *   buttons, so every note the graph shows can be reached and opened without
 *   a pointer.
 * - **It shares `MindMapViewer`'s shell** — the same portal on `document.body`,
 *   the same bar, the same gestures through `usePanZoom`.
 * - **The layout settles on screen.** It runs in slices of a few milliseconds
 *   a frame (`createLayout`), so a large library opens at once and arranges
 *   itself, rather than opening late and finished.
 * - **Unlinked mentions are opt-in.** They are the half that reads every
 *   note's text, so the graph is fetched without them until they are asked for.
 * - **It takes the keyboard.** The overlay covers the window, so focus moves
 *   into it and Tab stays there; otherwise a keystroke meant for the graph
 *   lands in the note still focused underneath.
 */
import {
  FilterX,
  Link2,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Search,
  Settings,
  Sparkles,
  Unlink,
  Waypoints,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { GlassSelect } from '@/components/glass';
import { useAiAvailability } from '@/app/ai/useAiAvailability';
import { aiErrorMessage } from '@/app/ai/aiErrorMessage';
import { MAX_AI_SOURCES, suggestionKey, type LinkSuggestion } from '@/lib/ai';
import {
  acceptSuggestedLinkCommand,
  readGraphCommand,
  runAppCommand,
  suggestLinksCommand,
} from '@/lib/commands';
import { createLayout, spreadFor, type GraphLayout } from '@/lib/graph/layout';
import {
  DEFAULT_GRAPH_FILTERS,
  indexGraph,
  selectGraph,
  type GraphCourseFilter,
  type GraphFilters,
  type GraphIndex,
  type GraphSince,
} from '@/lib/graph/selection';
import { tagLabel } from '@/lib/notes/tagLabel';
import type { LibraryGraph } from '@/lib/schema';
import { fold } from '@/lib/search/fold';
import { useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { GraphDetail, type DetailNote } from './GraphDetail';
import { GraphSuggestions, type SuggestionRow } from './GraphSuggestions';
import {
  usePanZoom,
  ZOOM_STEP,
  type ContentBox,
  type Point,
  type View,
} from './usePanZoom';
import './graph.css';

const MIN_ZOOM = 0.04;
const MAX_ZOOM = 5;
const FIT_PADDING = 28;
/** A dozen notes should not be blown up to fill the window. */
const MAX_FIT_ZOOM = 1.5;
/** Milliseconds of layout per frame — half a frame, leaving the other half to
 * draw what it produced. */
const LAYOUT_SLICE_MS = 8;
/** How long the camera takes to glide to a note or back to the whole graph. */
const GLIDE_MS = 260;
/** Two clicks on one note this close together open it. */
const DOUBLE_TAP_MS = 380;
/** The detail card's width plus its margin — the part of the stage it covers. */
const DETAIL_SPAN = 348;
/** The same, for the suggestions panel down the other side. */
const SUGGEST_SPAN = 364;
/** Below this much free stage, a panel is fitted under and not beside. */
const MIN_FREE_STAGE = 440;
const MAX_RESULTS = 8;
const MAX_LABELS = 260;
const SINCE: GraphSince[] = ['any', 'week', 'month', 'term', 'year'];
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The radius of an empty, unlinked note, in graph units. */
const MIN_RADIUS = 6;

/**
 * How big a note's dot is.
 *
 * Two things, because a library with no links yet has only one of them: how
 * much the note says (its length — a long lecture is a bigger dot than a
 * two-line reminder) and how connected it is. Length saturates early, so one
 * very long note does not dwarf the rest.
 */
function nodeRadius(degree: number, size: number): number {
  return MIN_RADIUS + Math.min(7, Math.sqrt(size) / 13) + 1.8 * Math.sqrt(degree);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** Same notes, same links, in the same order — so the same layout. */
function sameStructure(a: GraphIndex, b: GraphIndex): boolean {
  return (
    a.count === b.count &&
    a.links.length === b.links.length &&
    a.nodes.every((node, position) => node.id === b.nodes[position]!.id) &&
    a.links.every((value, position) => value === b.links[position]) &&
    a.groups.every((value, position) => value === b.groups[position])
  );
}

interface Palette {
  surface: string;
  /** The plate behind the name under the pointer. */
  raised: string;
  border: string;
  text: string;
  /** Ordinary labels. */
  label: string;
  /** Notes in no course, and the links between notes. */
  muted: string;
  accent: string;
  font: string;
}

function readPalette(element: HTMLElement): Palette {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    surface: token('--nb-inset-surface', '#f3f1ec'),
    raised: token('--nb-surface', '#ffffff'),
    border: token('--nb-control-border', '#ccc8c0'),
    text: token('--nb-text', '#20201e'),
    label: token('--nb-text-2', '#55534f'),
    muted: token('--nb-text-3', '#85817a'),
    accent: token('--nb-accent', '#9b5c2f'),
    font: style.fontFamily || 'sans-serif',
  };
}

/** A course as the graph draws it: a named, tinted patch its notes sit in. */
interface Region {
  name: string;
  /** Course colour, or empty for the notes in no course. */
  colour: string;
  members: number[];
}

interface Scene {
  index: GraphIndex;
  x: Float32Array;
  y: Float32Array;
  /** Dot radius per node, in graph units. */
  radius: Float32Array;
  /** The smallest a dot is drawn, in screen pixels. */
  minDot: number;
  /** Course colour per node; empty for a note in no course. */
  colours: string[];
  regions: Region[];
  /** Node indices in the order labels are offered: most connected, then
   * longest. */
  byWeight: number[];
  title(node: number): string;
  /** "Physics I · 4 links" — the second line under a hovered name. */
  describe(node: number): string;
}

interface Emphasis {
  /** Nodes to keep at full strength; everything else recedes. Null for none. */
  lit: Set<number> | null;
  hovered: number | null;
  /** The note whose detail card is open. */
  selected: number | null;
  /** The note open in the editor — "you are here". */
  current: number | null;
  /** Links a model proposed and the student has not answered yet. */
  suggested: Uint32Array;
}

interface Circle {
  x: number;
  y: number;
  r: number;
}

/** Room between a region's outermost note and its edge. */
const REGION_PADDING = 30;
/** Room kept above a region for its name, in graph units at 100%. */
const REGION_TITLE_SPACE = 30;

/** The patch each course covers: the smallest circle about its notes' centre
 * that holds them all, with room to breathe. */
function regionCircles(scene: Scene): Circle[] {
  return scene.regions.map(({ members }) => {
    let cx = 0;
    let cy = 0;
    for (const node of members) {
      cx += scene.x[node]!;
      cy += scene.y[node]!;
    }
    cx /= members.length;
    cy /= members.length;
    let reach = 0;
    for (const node of members) {
      reach = Math.max(
        reach,
        Math.hypot(scene.x[node]! - cx, scene.y[node]! - cy) + scene.radius[node]!,
      );
    }
    return { x: cx, y: cy, r: reach + REGION_PADDING };
  });
}

/** What "fit" must show: every course's patch, and the name above it. */
function sceneBounds(scene: Scene): ContentBox {
  const circles = regionCircles(scene);
  if (!circles.length) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const circle of circles) {
    minX = Math.min(minX, circle.x - circle.r);
    maxX = Math.max(maxX, circle.x + circle.r);
    minY = Math.min(minY, circle.y - circle.r - REGION_TITLE_SPACE);
    // A note's name hangs below it, past the edge of the patch.
    maxY = Math.max(maxY, circle.y + circle.r + 12);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** A name on at most two lines, the second ending in an ellipsis if cut. */
function wrapLabel(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const fits = (line: string) => context.measureText(line).width <= maxWidth;
  if (fits(text)) return [text];
  const lines = [''];
  let cut = false;
  for (const word of text.split(/\s+/)) {
    const current = lines[lines.length - 1]!;
    const joined = current ? `${current} ${word}` : word;
    if (!current || fits(joined)) lines[lines.length - 1] = joined;
    else if (lines.length < 2) lines.push(word);
    else {
      cut = true;
      break;
    }
  }
  // Shorten whatever still does not fit: a cut second line, or one word
  // longer than the line it sits on.
  return lines.map((line, row) => {
    let shown = cut && row === lines.length - 1 ? `${line}…` : line;
    while (shown.length > 2 && !fits(shown)) {
      shown = `${shown.slice(0, -2).trimEnd()}…`;
    }
    return shown;
  });
}

function draw(
  canvas: HTMLCanvasElement,
  scene: Scene,
  view: View,
  palette: Palette,
  { lit, hovered, selected, current, suggested }: Emphasis,
): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  const { index, x, y } = scene;
  const { k } = view;
  const dimmed = (node: number) => lit !== null && !lit.has(node);
  // The note whose links are drawn strong: the one under the pointer, or
  // failing that the one whose card is open.
  const focus = hovered ?? selected;
  const toScreen = (worldX: number, worldY: number) => ({
    x: worldX * k + view.x,
    y: worldY * k + view.y,
  });

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.translate(view.x, view.y);
  context.scale(k, k);
  context.lineCap = 'round';

  // -- courses ---------------------------------------------------------------
  // Drawn first and faintly: a library with no links at all is still a
  // library in courses, and that is the structure it has to show.
  const circles = regionCircles(scene);
  scene.regions.forEach((region, position) => {
    const circle = circles[position]!;
    const colour = region.colour || palette.muted;
    context.beginPath();
    context.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
    context.globalAlpha = lit ? 0.04 : 0.09;
    context.fillStyle = colour;
    context.fill();
    context.globalAlpha = lit ? 0.14 : 0.32;
    context.lineWidth = 1.2 / k;
    context.strokeStyle = colour;
    // Notes in no course are a holding area, not a course: a dashed edge.
    if (!region.colour) context.setLineDash([5 / k, 5 / k]);
    context.stroke();
    context.setLineDash([]);
  });

  // -- links -----------------------------------------------------------------
  const strokeLinks = (links: Uint32Array, wanted: boolean | null) => {
    context.beginPath();
    for (let link = 0; link < links.length; link += 2) {
      const source = links[link]!;
      const target = links[link + 1]!;
      if (wanted !== null) {
        const touches = focus !== null && (source === focus || target === focus);
        if (touches !== wanted) continue;
      }
      context.moveTo(x[source]!, y[source]!);
      context.lineTo(x[target]!, y[target]!);
    }
    context.stroke();
  };

  // Links, then mentions, each in two passes when a note has the focus: the
  // ones that do not touch it recede, the ones that do are drawn over them.
  //
  // The link ink is the muted text colour at part strength rather than a
  // divider token: a divider is tuned to sit on a panel, and on the stage's
  // inset surface it all but disappears in the dark theme.
  context.lineWidth = 1.4 / k;
  context.strokeStyle = palette.muted;
  context.globalAlpha = lit ? 0.14 : 0.55;
  strokeLinks(index.links, focus === null ? null : false);
  if (index.mentionLinks.length) {
    context.setLineDash([4 / k, 6 / k]);
    context.strokeStyle = palette.accent;
    context.globalAlpha = lit ? 0.18 : 0.8;
    strokeLinks(index.mentionLinks, focus === null ? null : false);
    context.setLineDash([]);
  }
  if (suggested.length) {
    // Dotted, not dashed: a mention is a fact about the text, a suggestion is
    // an opinion, and the two must not be mistaken for each other.
    context.setLineDash([0.5 / k, 7 / k]);
    context.lineWidth = 3 / k;
    context.strokeStyle = palette.accent;
    context.globalAlpha = 0.95;
    strokeLinks(suggested, null);
    context.setLineDash([]);
  }
  if (focus !== null) {
    context.globalAlpha = 0.9;
    context.lineWidth = 2 / k;
    context.strokeStyle = palette.label;
    strokeLinks(index.links, true);
    context.setLineDash([4 / k, 6 / k]);
    context.strokeStyle = palette.accent;
    context.globalAlpha = 1;
    strokeLinks(index.mentionLinks, true);
    context.setLineDash([]);
  }

  // -- notes -----------------------------------------------------------------
  // Never smaller than this on screen, however far out the view is. A small
  // library is all the way out when it is merely fitted to the window, and
  // its dots are the whole picture: they get a floor a thumb could land on.
  const floor = scene.minDot / k;
  // The floor is for the smallest note; a longer one keeps its lead over it,
  // so size still says something when every dot is on the floor.
  const radiusOf = (node: number) =>
    Math.max(scene.radius[node]!, (floor * scene.radius[node]!) / MIN_RADIUS);
  // A hairline of the surface colour around each dot, so two that touch read
  // as two. Skipped once the dots are too small for it to be anything but mud.
  const outlined = Math.max(MIN_RADIUS * k, scene.minDot) >= 2.5;
  context.lineWidth = 1.6 / k;
  context.strokeStyle = palette.surface;
  for (let node = 0; node < index.count; node += 1) {
    context.globalAlpha = dimmed(node) ? 0.2 : 1;
    context.fillStyle = scene.colours[node] || palette.muted;
    context.beginPath();
    context.arc(x[node]!, y[node]!, radiusOf(node), 0, Math.PI * 2);
    context.fill();
    if (outlined) context.stroke();
  }
  const ring = (node: number, colour: string, gap: number) => {
    context.globalAlpha = 1;
    context.lineWidth = 2.2 / k;
    context.strokeStyle = colour;
    context.beginPath();
    context.arc(x[node]!, y[node]!, radiusOf(node) + gap / k, 0, Math.PI * 2);
    context.stroke();
  };
  // Three rings that can land on one note, so each sits a little further out:
  // open in the editor, selected, under the pointer.
  if (current !== null) ring(current, palette.accent, 3.5);
  if (selected !== null) ring(selected, palette.text, selected === current ? 7.5 : 3.5);
  if (hovered !== null && hovered !== selected) {
    ring(hovered, palette.label, hovered === current ? 7.5 : 3.5);
  }

  // -- words, in screen space so they stay one size at any zoom --------------
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  let names = 0;
  /** A note is named once, however many reasons there are to name it. */
  const named = new Set<number>();
  const collides = (box: (typeof placed)[number]) =>
    placed.some(
      (other) =>
        box.left < other.right + 6 &&
        box.right > other.left - 6 &&
        box.top < other.bottom + 2 &&
        box.bottom > other.top - 2,
    );

  // The dots themselves are obstacles: a name printed across a neighbour's
  // dot hides the note it was meant to help find. Only while there are few
  // enough for it to matter and to be cheap.
  if (index.count <= 400) {
    for (let node = 0; node < index.count; node += 1) {
      const at = toScreen(x[node]!, y[node]!);
      if (at.x < -20 || at.x > width + 20 || at.y < -20 || at.y > height + 20) continue;
      const reach = radiusOf(node) * k;
      placed.push({
        left: at.x - reach,
        right: at.x + reach,
        top: at.y - reach,
        bottom: at.y + reach,
      });
    }
  }

  // Course names first: they are the map's legend, written on the map, and
  // every note's name gives way to them.
  const regionFont = `600 14px ${palette.font}`;
  context.font = regionFont;
  scene.regions.forEach((region, position) => {
    const circle = circles[position]!;
    const top = toScreen(circle.x, circle.y - circle.r);
    const text = `${truncate(region.name, 34)}  ·  ${region.members.length}`;
    const textWidth = context.measureText(text).width;
    const baseline = top.y - 15;
    if (baseline < -10 || baseline > height + 10) return;
    placed.push({
      left: top.x - textWidth / 2,
      right: top.x + textWidth / 2,
      top: baseline - 9,
      bottom: baseline + 9,
    });
    context.globalAlpha = lit ? 0.45 : 1;
    context.textAlign = 'center';
    context.lineWidth = 4;
    context.strokeStyle = palette.surface;
    context.strokeText(text, top.x, baseline);
    context.fillStyle = palette.label;
    context.fillText(text, top.x, baseline);
  });

  const labelFont = `500 13px ${palette.font}`;
  const strongFont = `600 13px ${palette.font}`;
  const LINE = 16;
  const MAX_LABEL_WIDTH = 184;

  // `strong` is the ink; `forced` skips the overlap test. A name sits under
  // its note, centred — where it reads as belonging to the dot and leaves the
  // sides free for neighbours — and tries above, then beside, before giving up.
  const label = (node: number, strong: boolean, forced = false) => {
    if (names >= MAX_LABELS || named.has(node)) return;
    const at = toScreen(x[node]!, y[node]!);
    if (at.x < -90 || at.x > width + 90 || at.y < -40 || at.y > height + 40) return;
    context.font = strong ? strongFont : labelFont;
    const lines = wrapLabel(context, scene.title(node), MAX_LABEL_WIDTH);
    const textWidth = Math.max(...lines.map((line) => context.measureText(line).width));
    const textHeight = lines.length * LINE;
    const ringed = node === selected || node === current ? 6 : 0;
    const reach = radiusOf(node) * k + 8 + ringed;
    const options = [
      { left: at.x - textWidth / 2, top: at.y + reach, align: 'center' as const },
      {
        left: at.x - textWidth / 2,
        top: at.y - reach - textHeight,
        align: 'center' as const,
      },
      { left: at.x + reach + 2, top: at.y - textHeight / 2, align: 'left' as const },
      {
        left: at.x - reach - 2 - textWidth,
        top: at.y - textHeight / 2,
        align: 'right' as const,
      },
    ];
    const spot =
      options.find(
        (option) =>
          !collides({
            left: option.left,
            right: option.left + textWidth,
            top: option.top,
            bottom: option.top + textHeight,
          }),
      ) ?? (forced ? options[0]! : null);
    // A name that would sit on another is dropped rather than overprinted —
    // the weightier note asked first.
    if (!spot) return;
    placed.push({
      left: spot.left,
      right: spot.left + textWidth,
      top: spot.top,
      bottom: spot.top + textHeight,
    });
    names += 1;
    named.add(node);
    context.globalAlpha = dimmed(node) ? 0.32 : 1;
    context.textAlign = spot.align;
    const anchor =
      spot.align === 'center'
        ? spot.left + textWidth / 2
        : spot.align === 'left'
          ? spot.left
          : spot.left + textWidth;
    lines.forEach((line, row) => {
      const baseline = spot.top + LINE / 2 + row * LINE;
      // A halo of the surface colour, so a name stays legible over a line.
      context.lineWidth = 4;
      context.strokeStyle = palette.surface;
      context.strokeText(line, anchor, baseline);
      context.fillStyle = strong ? palette.text : palette.label;
      context.fillText(line, anchor, baseline);
    });
  };

  // The note under the pointer gets a plate of its own, with a second line
  // saying where it lives and how connected it is. It is reserved first, so
  // every other name gives way to it, and painted last, so nothing covers it.
  let plate: (() => void) | null = null;
  if (hovered !== null) {
    const at = toScreen(x[hovered]!, y[hovered]!);
    const title = truncate(scene.title(hovered), 56);
    const meta = scene.describe(hovered);
    const metaFont = `400 11.5px ${palette.font}`;
    const titleFont = `600 13.5px ${palette.font}`;
    context.font = titleFont;
    const titleWidth = context.measureText(title).width;
    context.font = metaFont;
    const metaWidth = context.measureText(meta).width;
    const plateWidth = Math.max(titleWidth, metaWidth) + 24;
    const plateHeight = 48;
    const offset = radiusOf(hovered) * k + 12;
    // To the right of the note, unless that would run off the window.
    const left =
      at.x + offset + plateWidth > width - 8 ? at.x - offset - plateWidth : at.x + offset;
    const top = Math.min(Math.max(at.y - plateHeight / 2, 8), height - plateHeight - 8);
    placed.push({ left, right: left + plateWidth, top, bottom: top + plateHeight });
    plate = () => {
      context.globalAlpha = 1;
      context.textAlign = 'left';
      context.shadowColor = 'rgba(0, 0, 0, 0.2)';
      context.shadowBlur = 14;
      context.shadowOffsetY = 4;
      context.fillStyle = palette.raised;
      context.beginPath();
      context.roundRect(left, top, plateWidth, plateHeight, 9);
      context.fill();
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;
      context.lineWidth = 1;
      context.strokeStyle = palette.border;
      context.stroke();
      context.font = titleFont;
      context.fillStyle = palette.text;
      context.fillText(title, left + 12, top + 17);
      context.font = metaFont;
      context.fillStyle = palette.muted;
      context.fillText(meta, left + 12, top + 34);
    };
  }
  if (selected !== null && selected !== hovered) label(selected, true, true);
  if (focus !== null) {
    for (const neighbour of index.neighbours[focus]!) {
      if (neighbour !== hovered) label(neighbour, true);
    }
  }
  for (let link = 0; link < suggested.length; link += 1) {
    const node = suggested[link]!;
    if (node !== hovered && node !== selected) label(node, true);
  }
  if (current !== null && current !== hovered && current !== selected) {
    label(current, true, focus === null);
  }
  if (lit && lit.size <= 40) {
    for (const node of lit) if (node !== hovered) label(node, true);
  }
  for (const node of scene.byWeight) {
    // A name is offered once its dot is big enough on screen to be worth
    // naming; a well-connected note earns one from further out.
    const visible =
      index.count <= 60 || scene.radius[node]! * k >= 4 || index.degree[node]! >= 3;
    if (visible && node !== hovered && node !== selected) label(node, false);
  }
  plate?.();
  context.globalAlpha = 1;
  context.textAlign = 'left';
}

export function GraphView() {
  const { t, i18n } = useTranslation();
  const onClose = useCallback(() => useUiStore.getState().setGraphOpen(false), []);
  const courses = useLibraryStore((state) => state.courses);
  const tags = useLibraryStore((state) => state.tags);
  const openNoteId = useEditorStore((state) => state.note?.id ?? null);

  const root = useRef<HTMLDivElement>(null);
  const findField = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [graph, setGraph] = useState<LibraryGraph | null>(null);
  /** Whether `graph` was read with its unlinked mentions. */
  const [hasMentions, setHasMentions] = useState(false);
  const [error, setError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_GRAPH_FILTERS);
  const [query, setQuery] = useState('');
  const [hovered, setHovered] = useState<number | null>(null);
  /** The note whose detail card is open — an id, so it survives a re-read. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastTap = useRef<{ id: string; at: number } | null>(null);
  /** Set when a layout continues the one on screen, so the camera stays put. */
  const keepCamera = useRef(false);
  /** Bumped as the layout advances and as the stage resizes: "draw again". */
  const [frame, setFrame] = useState(0);
  /** Follow the layout with the camera until the student moves it themselves. */
  const following = useRef(true);
  const glideHandle = useRef(0);

  // -- data ------------------------------------------------------------------
  useEffect(() => {
    // Mentions are fetched the first time they are asked for and kept after:
    // switching them off again is a filter, not another read.
    //
    // A library with no links at all is also read for them, unasked: with
    // nothing to draw, "three of your notes already name each other" is the
    // most useful thing this view can say, and it has to count them to say it.
    const wanted = filters.mentions || (graph !== null && graph.edges.length === 0);
    if (graph && (hasMentions || !wanted)) return;
    let active = true;
    void readGraphCommand({ mentions: wanted }).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError('');
      setHasMentions(wanted);
      setGraph(result.value);
    });
    return () => {
      active = false;
    };
  }, [graph, hasMentions, filters.mentions, readAttempt]);

  /** Read the graph again after a link was made from here. */
  const reload = useCallback(() => {
    setHovered(null);
    void readGraphCommand({ mentions: hasMentions }).then((result) => {
      if (result.ok) {
        setError('');
        setGraph(result.value);
      } else setError(result.message);
    });
  }, [hasMentions]);

  const selection = useMemo(
    () => (graph ? selectGraph(graph, filters) : null),
    [graph, filters],
  );
  const courseOrder = useMemo(() => courses.map((course) => course.id), [courses]);
  const index = useMemo(
    () => (selection ? indexGraph(selection, courseOrder) : null),
    [selection, courseOrder],
  );
  // Turning mentions on or off changes what is drawn, not where: mentions are
  // not layout forces. So the layout is kept while the notes and links are the
  // same, and a toggle never makes the picture rearrange itself.
  const settled = useRef<{ index: GraphIndex; layout: GraphLayout } | null>(null);
  const layout = useMemo(() => {
    if (!index) return null;
    const previous = settled.current;
    if (previous && sameStructure(previous.index, index)) {
      settled.current = { index, layout: previous.layout };
      return previous.layout;
    }
    // The same notes with a link more or less — one was just made from the
    // detail card. Continue from the picture on screen instead of dealing
    // every note out again.
    const continues =
      previous !== null &&
      previous.layout.done &&
      previous.index.count === index.count &&
      previous.index.nodes.every(
        (node, position) => node.id === index.nodes[position]!.id,
      );
    const created = createLayout(index, {
      warm: continues ? previous.layout : undefined,
      spread: spreadFor(index.count),
    });
    keepCamera.current = continues;
    // Watching it settle is motion; whoever asked for less gets the result.
    if (prefersReducedMotion()) created.finish();
    settled.current = { index, layout: created };
    return created;
  }, [index]);

  const scene = useMemo<Scene | null>(() => {
    if (!index || !layout) return null;
    const courseOf = new Map(courses.map((course) => [course.id, course]));
    return {
      index,
      x: layout.x,
      y: layout.y,
      radius: Float32Array.from(index.nodes, (node, position) =>
        nodeRadius(index.degree[position]!, node.size),
      ),
      minDot:
        index.count <= 40 ? 6.5 : index.count <= 160 ? 4.5 : index.count <= 600 ? 3 : 1.8,
      colours: index.nodes.map((node) =>
        node.courseId ? (courseOf.get(node.courseId)?.color ?? '') : '',
      ),
      // One patch per course that has notes on screen, and one for the notes
      // in none.
      regions: [-1, ...index.groupIds.keys()]
        .map((group) => ({
          name:
            group < 0
              ? t('graph.noCourse')
              : (courseOf.get(index.groupIds[group]!)?.name ?? ''),
          colour: group < 0 ? '' : (courseOf.get(index.groupIds[group]!)?.color ?? ''),
          members: index.nodes.flatMap((_, node) =>
            index.groups[node] === group ? [node] : [],
          ),
        }))
        .filter((region) => region.members.length > 0),
      byWeight: index.nodes
        .map((_, node) => node)
        .sort(
          (a, b) =>
            index.degree[b]! - index.degree[a]! ||
            index.nodes[b]!.size - index.nodes[a]!.size ||
            a - b,
        ),
      title: (node) => index.nodes[node]!.title.trim() || t('noteList.untitled'),
      describe: (node) => {
        const { courseId, updatedAt } = index.nodes[node]!;
        const course = courseId ? courseOf.get(courseId)?.name : null;
        const edited = new Date(updatedAt).toLocaleDateString(i18n.language, {
          day: 'numeric',
          month: 'short',
        });
        return [
          truncate(course ?? t('graph.noCourse'), 30),
          t('graph.links', { count: index.degree[node]! }),
          t('graph.editedShort', { date: edited }),
        ].join(' · ');
      },
    };
  }, [index, layout, courses, t, i18n.language]);

  // -- camera ----------------------------------------------------------------
  const openNote = useCallback(
    (noteId: string) => {
      const ui = useUiStore.getState();
      // Tasks and the task half of Trash have no editor on screen to open into.
      if (ui.view.kind === 'tasks' || ui.view.kind === 'trash') {
        ui.setView({ kind: 'all' });
      }
      onClose();
      ui.selectNote(noteId);
      void useEditorStore.getState().openNote(noteId);
    },
    [onClose],
  );

  const viewRef = useRef<View | null>(null);
  const selectRef = useRef<(node: number, closeUp: boolean) => void>(() => {});
  const hit = useCallback(
    (point: Point): number | null => {
      const view = viewRef.current;
      if (!scene || !view) return null;
      const worldX = (point.x - view.x) / view.k;
      const worldY = (point.y - view.y) / view.k;
      let best: number | null = null;
      // Generous at a distance: a two-pixel dot still needs a target a hand
      // can land on.
      let reach = Infinity;
      for (let node = 0; node < scene.index.count; node += 1) {
        const distance = Math.hypot(scene.x[node]! - worldX, scene.y[node]! - worldY);
        const radius = Math.max(
          scene.radius[node]!,
          ((scene.minDot + 3) * scene.radius[node]!) / MIN_RADIUS / view.k,
          8 / view.k,
        );
        if (distance <= radius && distance < reach) {
          best = node;
          reach = distance;
        }
      }
      return best;
    },
    [scene],
  );

  const { view, setView, dragging, fitTo, fitView, zoomAt, stageProps, handleKey } =
    usePanZoom({
      stage,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      fitPadding: FIT_PADDING,
      maxFitZoom: MAX_FIT_ZOOM,
      onClose,
      // A click on a note opens it, so a double-click must not also zoom.
      doubleClickZoom: false,
      onTap: (point) => {
        const node = hit(point);
        // A click on the empty stage puts the card away.
        if (node === null || !scene) {
          setSelectedId(null);
          return;
        }
        // One click says "tell me about this", a second says "take me there".
        const id = scene.index.nodes[node]!.id;
        const now = performance.now();
        const previous = lastTap.current;
        lastTap.current = { id, at: now };
        if (previous && previous.id === id && now - previous.at < DOUBLE_TAP_MS) {
          openNote(id);
          return;
        }
        selectRef.current(node, false);
      },
      onHover: (point) => setHovered(point && !dragging ? hit(point) : null),
    });
  viewRef.current = view;

  /** Move the camera over a few frames instead of cutting to the new view. */
  const glide = useCallback(
    (target: View | null) => {
      cancelAnimationFrame(glideHandle.current);
      const from = viewRef.current;
      if (!target) return;
      if (!from || prefersReducedMotion()) {
        setView(target);
        return;
      }
      const started = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - started) / GLIDE_MS);
        const eased = 1 - Math.pow(1 - progress, 3);
        setView({
          x: from.x + (target.x - from.x) * eased,
          y: from.y + (target.y - from.y) * eased,
          k: from.k + (target.k - from.k) * eased,
        });
        if (progress < 1) glideHandle.current = requestAnimationFrame(step);
      };
      glideHandle.current = requestAnimationFrame(step);
    },
    [setView],
  );
  useEffect(() => () => cancelAnimationFrame(glideHandle.current), []);

  // What the two side panels leave of the stage. Read through a ref because
  // the fits that use it are bound before the panels' state exists.
  const insetRef = useRef(() => ({ left: 0, right: 0 }));

  /** Back to the whole graph — the fit button and the `0` key. */
  const fit = useCallback(() => {
    if (!layout || !scene) return;
    following.current = true;
    glide(fitView(sceneBounds(scene), insetRef.current()));
  }, [layout, scene, fitView, glide]);

  // The resize observer below is bound once, and must fit with today's layout.
  const refit = useRef(() => {});
  refit.current = () => {
    if (scene && following.current) fitTo(sceneBounds(scene), insetRef.current());
  };

  // A new selection is a new picture: start following it again.
  useEffect(() => {
    setHovered(null);
    if (keepCamera.current) return;
    following.current = true;
    cancelAnimationFrame(glideHandle.current);
  }, [layout]);

  // Let the layout settle a slice at a time, drawing as it goes.
  useEffect(() => {
    if (!layout || !scene) return;
    let handle = 0;
    const step = () => {
      const done = layout.advance(LAYOUT_SLICE_MS);
      if (following.current) fitTo(sceneBounds(scene), insetRef.current());
      setFrame((current) => current + 1);
      if (!done) handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [layout, scene, fitTo]);

  // Size the canvas to the stage, in device pixels.
  useEffect(() => {
    const element = stage.current;
    const surface = canvas.current;
    if (!element || !surface) return;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      surface.width = Math.round(element.clientWidth * ratio);
      surface.height = Math.round(element.clientHeight * ratio);
      // A camera still on the layout keeps the whole graph in the new window;
      // one the student has moved stays where they put it.
      refit.current();
      setFrame((current) => current + 1);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Any gesture of the student's own takes the camera from the layout, and
  // from a glide that is still under way.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const release = () => {
      following.current = false;
      cancelAnimationFrame(glideHandle.current);
    };
    element.addEventListener('pointerdown', release);
    element.addEventListener('wheel', release, { passive: true });
    element.addEventListener('gesturestart', release);
    return () => {
      element.removeEventListener('pointerdown', release);
      element.removeEventListener('wheel', release);
      element.removeEventListener('gesturestart', release);
    };
  }, []);

  // Take the keyboard on the way in, give it back on the way out, and keep
  // Tab inside in between.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === element)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    element.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const queryRef = useRef(query);
  queryRef.current = query;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A dialog opened over the graph owns its keys, including Escape.
      if (document.querySelector('[data-nb-modal]')) return;
      // ⌘F means "find" wherever it is pressed; here that is the find field,
      // and it must not also reach the note search behind the graph.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopImmediatePropagation();
        findField.current?.focus();
        findField.current?.select();
        return;
      }
      // Escape empties the find field first; only an empty one closes the
      // graph.
      if (event.key === 'Escape' && queryRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setQuery('');
        findField.current?.focus();
        return;
      }
      // Then the detail card; only then the graph itself.
      if (event.key === 'Escape' && selectedRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSelectedId(null);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Enter opens the selected note, unless a control has the focus and
      // Enter is its to act on.
      if (
        event.key === 'Enter' &&
        selectedRef.current &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest('button, input, select')
        )
      ) {
        event.preventDefault();
        openNote(selectedRef.current);
        return;
      }
      if (['+', '=', '-', '_'].includes(event.key)) {
        following.current = false;
        cancelAnimationFrame(glideHandle.current);
      }
      handleKey(event, fit);
    };
    // Capture, so these are decided before the app's own shortcut listener.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleKey, fit, openNote]);

  // -- find ------------------------------------------------------------------
  const matches = useMemo(() => {
    const wanted = fold(query.trim());
    if (!wanted || !scene) return null;
    return scene.byWeight.filter((node) => fold(scene.title(node)).includes(wanted));
  }, [query, scene]);

  /**
   * Bring a note into the part of the stage the detail card leaves free.
   *
   * A note already comfortably in view is left where it is — a camera that
   * recentres on every click is a camera the student has to chase. `closeUp`
   * also zooms in to reading distance, for a note reached by name rather than
   * by pointing at it.
   */
  const reveal = useCallback(
    (node: number, closeUp: boolean) => {
      const box = stage.current?.getBoundingClientRect();
      const current = viewRef.current;
      if (!box || !scene || !current) return;
      // "Close" is relative to how roomy the layout is: a small library is
      // spread out, and 100% there would show one note and nothing around it.
      const near = 1.3 / spreadFor(scene.index.count);
      const k = closeUp ? Math.max(current.k, near) : current.k;
      const free = Math.max(box.width - DETAIL_SPAN, box.width / 2);
      const screenX = scene.x[node]! * current.k + current.x;
      const screenY = scene.y[node]! * current.k + current.y;
      const inView =
        k === current.k &&
        screenX > 48 &&
        screenX < free - 48 &&
        screenY > 48 &&
        screenY < box.height - 48;
      if (inView) return;
      following.current = false;
      glide({
        k,
        x: free / 2 - scene.x[node]! * k,
        y: box.height / 2 - scene.y[node]! * k,
      });
    },
    [scene, glide],
  );

  const select = useCallback(
    (node: number, closeUp: boolean) => {
      if (!scene) return;
      setSelectedId(scene.index.nodes[node]!.id);
      reveal(node, closeUp);
    },
    [scene, reveal],
  );
  // `usePanZoom` is handed its tap handler before `select` exists.
  selectRef.current = select;

  /** Look at a find result without committing to it. */
  const centreOn = useCallback(
    (node: number) => {
      setHovered(node);
      reveal(node, true);
    },
    [reveal],
  );

  /** ↑ and ↓ walk the results from the field, the way a menu does. */
  function moveInResults(event: React.KeyboardEvent, from: number) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...(results.current?.querySelectorAll('button') ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const next = from + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) findField.current?.focus();
    else buttons[Math.min(next, buttons.length - 1)]!.focus();
  }

  // -- links a model proposes, for a library that has few or none -------------
  const canSuggest = useAiAvailability('default').available;
  const readOnly = useLibraryAccessStore((state) => state.status?.readOnly === true);
  const [suggestions, setSuggestions] = useState<{
    links: LinkSuggestion[];
    considered: number;
    total: number;
  } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState<string | null>(null);
  const [suggestError, setSuggestError] = useState('');
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const suggestRun = useRef<AbortController | null>(null);
  useEffect(() => () => suggestRun.current?.abort(), []);

  async function suggestLinks() {
    suggestRun.current?.abort();
    const run = new AbortController();
    suggestRun.current = run;
    setSuggesting(true);
    setSuggestError('');
    const result = await suggestLinksCommand({ signal: run.signal }, filters);
    if (run.signal.aborted) return;
    setSuggesting(false);
    if (!result.ok) {
      if (result.code !== 'cancelled') setSuggestError(aiErrorMessage(result, t));
      return;
    }
    setSuggestions({
      links: result.value.suggestions,
      considered: result.value.considered,
      total: result.value.total,
    });
  }

  const dropSuggestion = (link: LinkSuggestion) =>
    setSuggestions(
      (current) =>
        current && {
          ...current,
          links: current.links.filter(
            (entry) => suggestionKey(entry) !== suggestionKey(link),
          ),
        },
    );

  function cancelSuggestions() {
    suggestRun.current?.abort();
    setSuggesting(false);
  }

  async function acceptSuggestions(links: LinkSuggestion[], busy: string) {
    setSuggestBusy(busy);
    setSuggestError('');
    for (const link of links) {
      const result = await acceptSuggestedLinkCommand({
        sourceId: link.sourceId,
        targetId: link.targetId,
        label: t('graph.seeAlso'),
      });
      if (!result.ok) {
        setSuggestError(result.message);
        break;
      }
      dropSuggestion(link);
    }
    setSuggestBusy(null);
    reload();
  }

  const suggestionRows = useMemo<SuggestionRow[]>(() => {
    if (!suggestions || !scene) return [];
    return suggestions.links.flatMap((link) => {
      const source = scene.index.indexOf.get(link.sourceId);
      const target = scene.index.indexOf.get(link.targetId);
      // A filter may have taken one end off the screen; it comes back with it.
      if (source === undefined || target === undefined) return [];
      return [
        {
          ...link,
          sourceTitle: scene.title(source),
          targetTitle: scene.title(target),
          sourceColour: scene.colours[source]!,
          targetColour: scene.colours[target]!,
        },
      ];
    });
  }, [suggestions, scene]);
  const suggested = useMemo(() => {
    if (!scene) return new Uint32Array(0);
    return Uint32Array.from(
      suggestionRows.flatMap((row) => [
        scene.index.indexOf.get(row.sourceId)!,
        scene.index.indexOf.get(row.targetId)!,
      ]),
    );
  }, [suggestionRows, scene]);

  // -- drawing ---------------------------------------------------------------
  // Null while a filter hides the selected note; it comes back with the note.
  const selected = selectedId ? (index?.indexOf.get(selectedId) ?? null) : null;
  const lit = useMemo(() => {
    if (matches) return new Set(matches);
    const focus = hovered ?? selected;
    if (focus !== null && index) {
      return new Set([focus, ...(index.neighbours[focus] ?? [])]);
    }
    return null;
  }, [matches, hovered, selected, index]);

  useEffect(() => {
    const surface = canvas.current;
    const element = stage.current;
    if (!surface || !element || !scene || !view) return;
    draw(surface, scene, view, readPalette(element), {
      lit,
      hovered: hovered !== null && hovered < scene.index.count ? hovered : null,
      selected,
      current: openNoteId ? (scene.index.indexOf.get(openNoteId) ?? null) : null,
      suggested,
    });
  }, [scene, view, lit, hovered, selected, openNoteId, suggested, frame]);

  // -- AI, where a provider is set up ----------------------------------------
  // Three hand-offs to features that already exist. None runs here: each one
  // leaves the graph for the surface that owns the feature, with the graph's
  // selection as its input.
  const canSynthesize = useAiAvailability('synthesis').available;
  const canAsk = useAiAvailability('ask').available;
  const canRunAgent = useAiAvailability('agent').available;

  /** Put the inspector's AI tab on screen, as the conversation or the agent. */
  const showAiTab = useCallback((agent: boolean) => {
    const ui = useUiStore.getState();
    if (!ui.inspectorVisible) ui.toggleInspector();
    ui.setInspectorTab('ai');
    useAiStore.getState().setAgentMode(agent);
  }, []);

  const synthesizeNeighbourhood = useCallback(
    (note: DetailNote, linked: DetailNote[]) => {
      // The selected note first, then its links, up to what Synthesis takes.
      const sources = [note, ...linked]
        .filter(
          (entry, position, all) => all.findIndex((x) => x.id === entry.id) === position,
        )
        .slice(0, MAX_AI_SOURCES);
      const ui = useUiStore.getState();
      ui.setAiSources({
        noteIds: sources.map((entry) => entry.id),
        titles: sources.map((entry) => entry.title),
      });
      onClose();
      ui.setAiSynthesisOpen(true);
    },
    [onClose],
  );

  const askAboutNeighbourhood = useCallback(
    (noteId: string) => {
      openNote(noteId);
      useAiStore.getState().setAskScope('linked');
      showAiTab(false);
    },
    [openNote, showAiTab],
  );

  /** Hand the mentions on screen to the agent, as a task it can be asked to plan. */
  const linkMentionsWithAgent = useCallback(() => {
    const courseId = filters.course.startsWith('course:')
      ? filters.course.slice('course:'.length)
      : null;
    const course = courses.find((entry) => entry.id === courseId)?.name;
    useUiStore
      .getState()
      .setAgentDraft(
        course ? t('graph.agentTaskCourse', { course }) : t('graph.agentTask'),
      );
    useAiStore.getState().setAskScope('library');
    onClose();
    showAiTab(true);
  }, [filters.course, courses, t, onClose, showAiTab]);

  const panelLeft = suggestions !== null;
  const panelRight = selected !== null;
  insetRef.current = () => {
    const width = stage.current?.clientWidth ?? 0;
    const left = panelLeft ? SUGGEST_SPAN : 0;
    const right = panelRight ? DETAIL_SPAN : 0;
    return width - left - right >= MIN_FREE_STAGE
      ? { left, right }
      : { left: 0, right: 0 };
  };
  // A panel arriving or leaving changes what "the whole graph" has to fit in.
  useEffect(() => {
    if (following.current) refit.current();
  }, [panelLeft, panelRight]);

  /** Everything the detail card says about the selected note. */
  const detail = useMemo(() => {
    if (selected === null || !scene) return null;
    const { index } = scene;
    const entry = (node: number): DetailNote => ({
      id: index.nodes[node]!.id,
      title: scene.title(node),
      colour: scene.colours[node]!,
    });
    const ends = (links: Uint32Array, from: 0 | 1) => {
      const found: DetailNote[] = [];
      for (let link = 0; link < links.length; link += 2) {
        if (links[link + from] === selected) found.push(entry(links[link + 1 - from]!));
      }
      return found.sort((a, b) => a.title.localeCompare(b.title));
    };
    const node = index.nodes[selected]!;
    return {
      note: entry(selected),
      course: courses.find((course) => course.id === node.courseId)?.name ?? null,
      tags: tags
        .filter((tag) => node.tagIds.includes(tag.id))
        .map((tag) => tagLabel(tag, t).full),
      updatedAt: node.updatedAt,
      linksTo: ends(index.links, 0),
      linkedFrom: ends(index.links, 1),
      mentions: ends(index.mentionLinks, 0),
      mentionedBy: ends(index.mentionLinks, 1),
    };
  }, [selected, scene, courses, tags, t]);

  // -- chrome ----------------------------------------------------------------
  const presentCourses = useMemo(() => {
    const present = new Set(graph?.nodes.map((node) => node.courseId));
    return courses.filter((course) => present.has(course.id));
  }, [graph, courses]);
  const hasLooseNotes = useMemo(
    () => graph?.nodes.some((node) => node.courseId === null) ?? false,
    [graph],
  );
  const presentTags = useMemo(() => {
    const present = new Set(graph?.nodes.flatMap((node) => node.tagIds));
    return tags
      .filter((tag) => present.has(tag.id))
      .map((tag) => ({ id: tag.id, label: tagLabel(tag, t).full }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [graph, tags, t]);

  const set = (patch: Partial<GraphFilters>) => {
    setHovered(null);
    cancelSuggestions();
    setSuggestError('');
    setFilters((current) => ({ ...current, ...patch }));
  };
  const narrowed =
    filters.course !== 'all' ||
    filters.tagId !== null ||
    filters.since !== 'any' ||
    filters.linkedOnly;
  const clearFilters = () =>
    set({ ...DEFAULT_GRAPH_FILTERS, mentions: filters.mentions });

  const shown = selection?.nodes.length ?? 0;
  /** Notes, and not one link between any of them. */
  const unlinked = graph !== null && graph.nodes.length > 1 && graph.edges.length === 0;
  const mentionTotal = hasMentions ? (graph?.mentions.length ?? 0) : 0;
  const libraryEmpty = graph !== null && graph.nodes.length === 0;
  const findingMentions = filters.mentions && !hasMentions && !error;
  const summary = selection
    ? [
        t('graph.notes', { count: shown }),
        t('graph.links', { count: selection.edges.length }),
        ...(filters.mentions && hasMentions
          ? [t('graph.mentionCount', { count: selection.mentions.length })]
          : []),
      ].join(' · ')
    : '';
  const notice = error
    ? error
    : !selection
      ? t('graph.loading')
      : findingMentions
        ? t('graph.findingMentions')
        : selection.trimmed === 'leastLinked'
          ? t('graph.trimmedLeastLinked', { shown, total: selection.matching })
          : selection.trimmed === 'unlinked'
            ? t('graph.trimmedUnlinked', { shown, total: selection.matching })
            : libraryEmpty
              ? ''
              : graph && graph.edges.length === 0
                ? t('graph.noLinks')
                : t('graph.hint');

  return createPortal(
    <div
      ref={root}
      tabIndex={-1}
      className="nb-map-viewer nb-graph"
      role="dialog"
      aria-modal="true"
      aria-label={t('graph.title')}
    >
      <header className="nb-map-viewer-bar">
        <h2 className="nb-map-viewer-title">{t('graph.title')}</h2>

        <div className="nb-graph-find" role="search">
          <Search size={13} aria-hidden />
          <input
            ref={findField}
            type="search"
            value={query}
            placeholder={t('graph.find')}
            aria-label={t('graph.find')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && matches?.length) select(matches[0]!, true);
              moveInResults(event, -1);
            }}
          />
          {query && (
            <button
              type="button"
              className="nb-graph-find-clear"
              aria-label={t('graph.clearFind')}
              title={t('graph.clearFind')}
              onClick={() => {
                setQuery('');
                findField.current?.focus();
              }}
            >
              <X size={12} />
            </button>
          )}
          {matches && scene && (
            <ul
              ref={results}
              className="nb-graph-results"
              aria-label={t('graph.results')}
            >
              {matches.length === 0 && (
                <li className="nb-graph-none">{t('graph.noResults')}</li>
              )}
              {matches.slice(0, MAX_RESULTS).map((node, position) => (
                <li key={node}>
                  <button
                    type="button"
                    onMouseEnter={() => centreOn(node)}
                    onFocus={() => centreOn(node)}
                    onKeyDown={(event) => moveInResults(event, position)}
                    onClick={() => select(node, true)}
                  >
                    <span
                      className="nb-graph-dot"
                      style={{ background: scene.colours[node] || 'var(--nb-text-3)' }}
                    />
                    <span className="nb-graph-result-title">{scene.title(node)}</span>
                    <span className="nb-graph-result-meta">
                      {t('graph.links', { count: scene.index.degree[node]! })}
                    </span>
                  </button>
                </li>
              ))}
              {matches.length > MAX_RESULTS && (
                <li className="nb-graph-none">
                  {t('graph.moreResults', { count: matches.length - MAX_RESULTS })}
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="nb-graph-filters">
          <GlassSelect
            className="nb-graph-select"
            label={t('graph.filterCourse')}
            size="sm"
            value={filters.course}
            onChange={(event) => set({ course: event.target.value as GraphCourseFilter })}
          >
            <option value="all">{t('graph.allCourses')}</option>
            {hasLooseNotes && <option value="inbox">{t('graph.noCourse')}</option>}
            {presentCourses.map((course) => (
              <option key={course.id} value={`course:${course.id}`}>
                {course.name}
              </option>
            ))}
          </GlassSelect>
          {presentTags.length > 0 && (
            <GlassSelect
              className="nb-graph-select"
              label={t('graph.filterTag')}
              size="sm"
              value={filters.tagId ?? ''}
              onChange={(event) => set({ tagId: event.target.value || null })}
            >
              <option value="">{t('graph.allTags')}</option>
              {presentTags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.label}
                </option>
              ))}
            </GlassSelect>
          )}
          <GlassSelect
            className="nb-graph-select"
            label={t('graph.filterSince')}
            size="sm"
            value={filters.since}
            onChange={(event) => set({ since: event.target.value as GraphSince })}
          >
            {SINCE.map((since) => (
              <option key={since} value={since}>
                {t(`graph.since.${since}`)}
              </option>
            ))}
          </GlassSelect>
        </div>

        <div className="nb-map-viewer-controls">
          <button
            type="button"
            aria-pressed={filters.linkedOnly}
            aria-label={t('graph.linkedOnly')}
            title={t('graph.linkedOnlyHint')}
            onClick={() => set({ linkedOnly: !filters.linkedOnly })}
          >
            <Link2 size={14} aria-hidden />
            <span className="nb-graph-toggle-text">{t('graph.linkedOnly')}</span>
          </button>
          <button
            type="button"
            aria-pressed={filters.mentions}
            aria-busy={findingMentions || undefined}
            aria-label={t('graph.mentions')}
            title={t('graph.mentionsHint')}
            onClick={() => set({ mentions: !filters.mentions })}
          >
            <Unlink size={14} aria-hidden />
            <span className="nb-graph-toggle-text">{t('graph.mentions')}</span>
          </button>
          {narrowed && (
            <button
              type="button"
              aria-label={t('graph.clearFilters')}
              title={t('graph.clearFilters')}
              onClick={clearFilters}
            >
              <FilterX size={14} aria-hidden />
            </button>
          )}
        </div>

        <div className="nb-map-viewer-controls">
          <button
            type="button"
            aria-label={t('mindMap.zoomOut')}
            title={t('mindMap.zoomOut')}
            onClick={() => {
              following.current = false;
              zoomAt(1 / ZOOM_STEP);
            }}
          >
            <Minus size={14} />
          </button>
          <span className="nb-map-viewer-scale" aria-live="polite">
            {Math.round((view?.k ?? 1) * 100)}%
          </span>
          <button
            type="button"
            aria-label={t('mindMap.zoomIn')}
            title={t('mindMap.zoomIn')}
            onClick={() => {
              following.current = false;
              zoomAt(ZOOM_STEP);
            }}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label={t('mindMap.fit')}
            title={t('mindMap.fit')}
            onClick={fit}
          >
            <Maximize2 size={14} />
          </button>
        </div>

        <button
          type="button"
          className="nb-map-viewer-close"
          aria-label={t('settings.title')}
          title={t('settings.title')}
          onClick={() => void runAppCommand('app.settings')}
        >
          <Settings size={15} aria-hidden />
        </button>
        <button
          type="button"
          className="nb-map-viewer-close"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>

      {/* A strip of its own rather than a card over the stage: over the stage
          it would sit on the very courses it is talking about. The stage
          shrinks to make room and the graph refits. */}
      {unlinked && !bannerDismissed && !suggestions && (
        <div className="nb-graph-banner" role="status">
          <div>
            <strong>{t('graph.unlinked.title')}</strong>
            <p>
              {mentionTotal > 0
                ? t('graph.unlinked.mentions', { count: mentionTotal })
                : t('graph.unlinked.tip')}
            </p>
            {suggestError && (
              <p role="alert" className="nb-graph-detail-error">
                {suggestError}
              </p>
            )}
          </div>
          <div className="nb-graph-banner-actions">
            {mentionTotal > 0 && !filters.mentions && (
              <button type="button" onClick={() => set({ mentions: true })}>
                <Unlink size={13} aria-hidden />
                {t('graph.unlinked.showMentions')}
              </button>
            )}
            {canSuggest && (
              <button
                type="button"
                className="is-primary"
                disabled={suggesting || shown < 2 || suggestBusy !== null}
                title={t('graph.unlinked.suggestHint')}
                onClick={() => void suggestLinks()}
              >
                {suggesting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Sparkles size={13} aria-hidden />
                )}
                {suggesting
                  ? t('graph.unlinked.suggesting')
                  : t('graph.unlinked.suggest')}
              </button>
            )}
            {suggesting && (
              <button type="button" onClick={cancelSuggestions}>
                {t('ai.cancel')}
              </button>
            )}
          </div>
          <button
            type="button"
            className="nb-graph-detail-close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => {
              cancelSuggestions();
              setBannerDismissed(true);
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {suggestError && !suggestions && (!unlinked || bannerDismissed) && (
        <div className="nb-graph-banner" role="alert">
          <p className="nb-graph-detail-error">{suggestError}</p>
        </div>
      )}
      <div
        ref={stage}
        className="nb-map-viewer-stage"
        data-dragging={dragging || undefined}
        data-over-note={hovered !== null || undefined}
        {...stageProps}
      >
        <canvas
          ref={canvas}
          className="nb-graph-canvas"
          role="img"
          aria-label={t('graph.canvasLabel', {
            notes: t('graph.notes', { count: shown }),
            links: t('graph.links', { count: selection?.edges.length ?? 0 }),
          })}
        />
        {selection && shown === 0 && (
          <div className="nb-graph-empty">
            <Waypoints size={26} aria-hidden />
            <p>{libraryEmpty ? t('graph.emptyLibrary') : t('graph.empty')}</p>
            {!libraryEmpty && narrowed && (
              <button type="button" onClick={clearFilters}>
                {t('graph.clearFilters')}
              </button>
            )}
          </div>
        )}
        {suggestions && (
          <GraphSuggestions
            rows={suggestionRows}
            hiddenCount={suggestions.links.length - suggestionRows.length}
            considered={suggestions.considered}
            total={suggestions.total}
            busy={suggestBusy}
            error={suggestError}
            readOnly={readOnly}
            onAccept={(row) => void acceptSuggestions([row], suggestionKey(row))}
            onAcceptAll={() => void acceptSuggestions(suggestionRows, 'all')}
            onDismiss={dropSuggestion}
            onPreview={(row) =>
              setHovered(
                row && scene ? (scene.index.indexOf.get(row.sourceId) ?? null) : null,
              )
            }
            onClose={() => setSuggestions(null)}
          />
        )}
        {detail && scene && (
          <GraphDetail
            {...detail}
            showMentions={filters.mentions && hasMentions}
            onSelect={(noteId) => {
              const node = scene.index.indexOf.get(noteId);
              if (node !== undefined) select(node, false);
            }}
            onPreview={(noteId) =>
              setHovered(noteId ? (scene.index.indexOf.get(noteId) ?? null) : null)
            }
            onOpen={() => openNote(detail.note.id)}
            onClose={() => setSelectedId(null)}
            onLinked={reload}
            onSynthesize={
              canSynthesize
                ? () =>
                    synthesizeNeighbourhood(detail.note, [
                      ...detail.linksTo,
                      ...detail.linkedFrom,
                    ])
                : undefined
            }
            onAsk={canAsk ? () => askAboutNeighbourhood(detail.note.id) : undefined}
            canSummarize={canAsk}
          />
        )}
      </div>

      <footer className="nb-graph-footer">
        <p
          className="nb-graph-status"
          data-tone={error ? 'danger' : undefined}
          aria-live="polite"
        >
          {summary && !error && <span className="nb-graph-summary">{summary}</span>}
          {canSuggest && shown > 1 && (!unlinked || bannerDismissed || suggestions) && (
            <button
              type="button"
              className="nb-graph-agent"
              disabled={suggestBusy !== null}
              title={t('graph.unlinked.suggestHint')}
              onClick={() => (suggesting ? cancelSuggestions() : void suggestLinks())}
            >
              {suggesting ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Sparkles size={11} aria-hidden />
              )}
              {suggesting ? t('ai.cancel') : t('graph.unlinked.suggest')}
            </button>
          )}
          {canRunAgent &&
            filters.mentions &&
            hasMentions &&
            !error &&
            (selection?.mentions.length ?? 0) > 0 && (
              <button
                type="button"
                className="nb-graph-agent"
                title={t('graph.agentHint')}
                onClick={linkMentionsWithAgent}
              >
                <Sparkles size={11} aria-hidden />
                {t('graph.agentAction')}
              </button>
            )}
          <span className="nb-graph-notice">{notice}</span>
          {error && (
            <button
              type="button"
              className="nb-graph-agent"
              onClick={() => {
                setError('');
                if (graph) reload();
                else setReadAttempt((attempt) => attempt + 1);
              }}
            >
              {t('graph.retry')}
            </button>
          )}
        </p>
        {/* The legend is also the fastest course filter: the colour you are
            looking at is the thing you click. */}
        <ul className="nb-graph-legend" aria-label={t('graph.legend')}>
          {hasLooseNotes && (
            <li>
              <button
                type="button"
                aria-pressed={filters.course === 'inbox'}
                onClick={() =>
                  set({ course: filters.course === 'inbox' ? 'all' : 'inbox' })
                }
              >
                <span
                  className="nb-graph-dot"
                  style={{ background: 'var(--nb-text-3)' }}
                />
                {t('graph.noCourse')}
              </button>
            </li>
          )}
          {presentCourses.map((course) => {
            const value: GraphCourseFilter = `course:${course.id}`;
            return (
              <li key={course.id}>
                <button
                  type="button"
                  aria-pressed={filters.course === value}
                  title={course.name}
                  onClick={() =>
                    set({ course: filters.course === value ? 'all' : value })
                  }
                >
                  <span className="nb-graph-dot" style={{ background: course.color }} />
                  <span className="nb-graph-legend-name">{course.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </footer>
    </div>,
    document.body,
  );
}
