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
  Maximize2,
  Minus,
  Plus,
  Search,
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
import { MAX_AI_SOURCES } from '@/lib/ai';
import { readGraphCommand } from '@/lib/commands';
import { createLayout, type GraphLayout } from '@/lib/graph/layout';
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
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { GraphDetail, type DetailNote } from './GraphDetail';
import { usePanZoom, ZOOM_STEP, type Point, type View } from './usePanZoom';
import './graph.css';

const MIN_ZOOM = 0.04;
const MAX_ZOOM = 5;
const FIT_PADDING = 40;
/** A dozen notes should not be blown up to fill the window. */
const MAX_FIT_ZOOM = 1.6;
/** Milliseconds of layout per frame — half a frame, leaving the other half to
 * draw what it produced. */
const LAYOUT_SLICE_MS = 8;
/** How long the camera takes to glide to a note or back to the whole graph. */
const GLIDE_MS = 260;
/** Two clicks on one note this close together open it. */
const DOUBLE_TAP_MS = 380;
/** The detail card's width plus its margin — the part of the stage it covers. */
const DETAIL_SPAN = 332;
const MAX_RESULTS = 8;
const MAX_LABELS = 260;
const LABEL_CHARS = 34;
const SINCE: GraphSince[] = ['any', 'week', 'month', 'term', 'year'];
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

function nodeRadius(degree: number): number {
  return 3.4 + 1.5 * Math.sqrt(degree);
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

interface Scene {
  index: GraphIndex;
  x: Float32Array;
  y: Float32Array;
  /** Course colour per node; empty for a note in no course. */
  colours: string[];
  /** Node indices, most connected first — the order labels are offered in. */
  byDegree: number[];
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
}

function draw(
  canvas: HTMLCanvasElement,
  scene: Scene,
  view: View,
  palette: Palette,
  { lit, hovered, selected, current }: Emphasis,
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

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.translate(view.x, view.y);
  context.scale(k, k);
  context.lineCap = 'round';

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

  // Links, then mentions, each in two passes when a note is hovered: the ones
  // that do not touch it recede, the ones that do are drawn over them.
  //
  // The link ink is the muted text colour at part strength rather than a
  // divider token: a divider is tuned to sit on a panel, and on the stage's
  // inset surface it all but disappears in the dark theme.
  context.lineWidth = 1 / k;
  context.strokeStyle = palette.muted;
  context.globalAlpha = lit ? 0.12 : 0.45;
  strokeLinks(index.links, focus === null ? null : false);
  if (index.mentionLinks.length) {
    context.setLineDash([3 / k, 5 / k]);
    context.strokeStyle = palette.accent;
    context.globalAlpha = lit ? 0.16 : 0.75;
    strokeLinks(index.mentionLinks, focus === null ? null : false);
    context.setLineDash([]);
  }
  if (focus !== null) {
    context.globalAlpha = 0.9;
    context.lineWidth = 1.5 / k;
    context.strokeStyle = palette.label;
    strokeLinks(index.links, true);
    context.setLineDash([3 / k, 5 / k]);
    context.strokeStyle = palette.accent;
    context.globalAlpha = 1;
    strokeLinks(index.mentionLinks, true);
    context.setLineDash([]);
  }

  // Never smaller than a couple of pixels, however far out the view is.
  const floor = 1.7 / k;
  const radiusOf = (node: number) => Math.max(nodeRadius(index.degree[node]!), floor);
  // A hairline of the surface colour around each dot, so two that touch read
  // as two. Skipped once the dots are too small for it to be anything but mud.
  const outlined = nodeRadius(0) * k >= 2.5;
  context.lineWidth = 1.5 / k;
  context.strokeStyle = palette.surface;
  for (let node = 0; node < index.count; node += 1) {
    context.globalAlpha = dimmed(node) ? 0.16 : 1;
    context.fillStyle = scene.colours[node] || palette.muted;
    context.beginPath();
    context.arc(x[node]!, y[node]!, radiusOf(node), 0, Math.PI * 2);
    context.fill();
    if (outlined) context.stroke();
  }
  const ring = (node: number, colour: string, gap: number) => {
    context.globalAlpha = 1;
    context.lineWidth = 2 / k;
    context.strokeStyle = colour;
    context.beginPath();
    context.arc(x[node]!, y[node]!, radiusOf(node) + gap / k, 0, Math.PI * 2);
    context.stroke();
  };
  // Three rings that can land on one note, so each sits a little further out:
  // open in the editor, selected, under the pointer.
  if (current !== null) ring(current, palette.accent, 3);
  if (selected !== null) ring(selected, palette.text, selected === current ? 6.5 : 3);
  if (hovered !== null && hovered !== selected) {
    ring(hovered, palette.label, hovered === current ? 6.5 : 3);
  }

  // Labels are drawn in screen space so they stay one size at any zoom.
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  const labelFont = `500 11px ${palette.font}`;
  context.font = labelFont;
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  const collides = (box: (typeof placed)[number]) =>
    placed.some(
      (other) =>
        box.left < other.right + 6 &&
        box.right > other.left - 6 &&
        box.top < other.bottom + 1 &&
        box.bottom > other.top - 1,
    );
  const onScreen = (screenX: number, screenY: number) =>
    screenX > -40 && screenX < width + 40 && screenY > -12 && screenY < height + 12;

  // `strong` is the ink; `forced` skips the overlap test. Emphasised
  // neighbours still give way to one another, or a hub's forty links print
  // forty names on one spot.
  const label = (node: number, strong: boolean, forced = false) => {
    if (placed.length >= MAX_LABELS) return;
    const screenX = x[node]! * k + view.x;
    const screenY = y[node]! * k + view.y;
    if (!onScreen(screenX, screenY)) return;
    const text = truncate(scene.title(node), LABEL_CHARS);
    // Clear of the ring, where the note wears one.
    const ringed = node === selected || node === current ? 5 : 0;
    const left = screenX + radiusOf(node) * k + 5 + ringed;
    const box = {
      left,
      right: left + context.measureText(text).width,
      top: screenY - 7,
      bottom: screenY + 7,
    };
    // A label that would sit on another is dropped rather than overprinted —
    // the better-connected note asked first.
    if (!forced && collides(box)) return;
    placed.push(box);
    context.globalAlpha = dimmed(node) ? 0.3 : 1;
    // A halo of the surface colour, so a name stays legible over a line.
    context.lineWidth = 3.5;
    context.strokeStyle = palette.surface;
    context.strokeText(text, left, screenY);
    context.fillStyle = strong ? palette.text : palette.label;
    context.fillText(text, left, screenY);
  };

  // The note under the pointer gets a plate of its own, with a second line
  // saying where it lives and how connected it is. It is reserved first, so
  // every other label gives way to it, and painted last, so nothing covers it.
  let plate: (() => void) | null = null;
  if (hovered !== null) {
    const screenX = x[hovered]! * k + view.x;
    const screenY = y[hovered]! * k + view.y;
    const title = truncate(scene.title(hovered), 48);
    const meta = scene.describe(hovered);
    const metaFont = `400 10.5px ${palette.font}`;
    const titleFont = `600 12px ${palette.font}`;
    context.font = titleFont;
    const titleWidth = context.measureText(title).width;
    context.font = metaFont;
    const metaWidth = context.measureText(meta).width;
    context.font = labelFont;
    const plateWidth = Math.max(titleWidth, metaWidth) + 20;
    const plateHeight = 40;
    const offset = radiusOf(hovered) * k + 10;
    // To the right of the note, unless that would run off the window.
    const left =
      screenX + offset + plateWidth > width - 8
        ? screenX - offset - plateWidth
        : screenX + offset;
    const top = Math.min(
      Math.max(screenY - plateHeight / 2, 8),
      height - plateHeight - 8,
    );
    placed.push({ left, right: left + plateWidth, top, bottom: top + plateHeight });
    plate = () => {
      context.globalAlpha = 1;
      context.shadowColor = 'rgba(0, 0, 0, 0.18)';
      context.shadowBlur = 12;
      context.shadowOffsetY = 3;
      context.fillStyle = palette.raised;
      context.beginPath();
      context.roundRect(left, top, plateWidth, plateHeight, 8);
      context.fill();
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;
      context.lineWidth = 1;
      context.strokeStyle = palette.border;
      context.stroke();
      context.font = titleFont;
      context.fillStyle = palette.text;
      context.fillText(title, left + 10, top + 14);
      context.font = metaFont;
      context.fillStyle = palette.muted;
      context.fillText(meta, left + 10, top + 28);
      context.font = labelFont;
    };
  }
  if (selected !== null && selected !== hovered) label(selected, true, true);
  if (focus !== null) {
    for (const neighbour of index.neighbours[focus]!) {
      if (neighbour !== hovered) label(neighbour, true);
    }
  }
  if (current !== null && current !== hovered && current !== selected) {
    label(current, true, focus === null);
  }
  if (lit && lit.size <= 40) {
    for (const node of lit) if (node !== hovered) label(node, true);
  }
  for (const node of scene.byDegree) {
    // The more connected a note, the further out its name still shows.
    const threshold = 1.2 - Math.min(index.degree[node]!, 9) * 0.1;
    if (k < threshold) break;
    if (node !== hovered && node !== selected) label(node, false);
  }
  plate?.();
  context.globalAlpha = 1;
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
    if (graph && (!filters.mentions || hasMentions)) return;
    let active = true;
    void readGraphCommand({ mentions: filters.mentions }).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError('');
      setHasMentions(filters.mentions);
      setGraph(result.value);
    });
    return () => {
      active = false;
    };
  }, [graph, hasMentions, filters.mentions]);

  /** Read the graph again after a link was made from here. */
  const reload = useCallback(() => {
    void readGraphCommand({ mentions: hasMentions }).then((result) => {
      if (result.ok) setGraph(result.value);
      else setError(result.message);
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
    const created = createLayout(index, continues ? previous.layout : undefined);
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
      colours: index.nodes.map((node) =>
        node.courseId ? (courseOf.get(node.courseId)?.color ?? '') : '',
      ),
      byDegree: index.nodes
        .map((_, node) => node)
        .sort((a, b) => index.degree[b]! - index.degree[a]! || a - b),
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
        const radius = Math.max(nodeRadius(scene.index.degree[node]!), 7 / view.k);
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

  /** Back to the whole graph — the fit button and the `0` key. */
  const fit = useCallback(() => {
    if (!layout) return;
    following.current = true;
    glide(fitView(layout.bounds()));
  }, [layout, fitView, glide]);

  // The resize observer below is bound once, and must fit with today's layout.
  const refit = useRef(() => {});
  refit.current = () => {
    if (layout && following.current) fitTo(layout.bounds());
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
    if (!layout) return;
    let handle = 0;
    const step = () => {
      const done = layout.advance(LAYOUT_SLICE_MS);
      if (following.current) fitTo(layout.bounds());
      setFrame((current) => current + 1);
      if (!done) handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [layout, fitTo]);

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
    return scene.byDegree.filter((node) => fold(scene.title(node)).includes(wanted));
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
      const k = closeUp ? Math.max(current.k, 1) : current.k;
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

  // -- drawing ---------------------------------------------------------------
  // Null while a filter hides the selected note; it comes back with the note.
  const selected = selectedId ? (index?.indexOf.get(selectedId) ?? null) : null;
  const lit = useMemo(() => {
    if (matches) return new Set(matches);
    const focus = hovered ?? selected;
    if (focus !== null && index) {
      return new Set([focus, ...index.neighbours[focus]!]);
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
    });
  }, [scene, view, lit, hovered, selected, openNoteId, frame]);

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

  const set = (patch: Partial<GraphFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const narrowed =
    filters.course !== 'all' ||
    filters.tagId !== null ||
    filters.since !== 'any' ||
    filters.linkedOnly;
  const clearFilters = () =>
    setFilters((current) => ({ ...DEFAULT_GRAPH_FILTERS, mentions: current.mentions }));

  const shown = selection?.nodes.length ?? 0;
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
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>

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
