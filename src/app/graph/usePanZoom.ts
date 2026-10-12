/**
 * Pan and zoom for a full-window stage.
 *
 * Lifted out of `MindMapViewer` when the graph view needed the same gestures:
 * a second copy of the wheel and pinch handling would be a second place for
 * the WebKit gesture trap below to be forgotten. The mind map zooms an image
 * and the graph a canvas, so this owns only the view — where the content is
 * and at what scale — and leaves drawing to the caller.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Point {
  x: number;
  y: number;
}

/** What `fit` centres: a rectangle in content coordinates. */
export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One press of the +/− control, and one notch of a mouse wheel. */
export const ZOOM_STEP = 1.25;
/** A pointer that travelled less than this was a click, not a drag. */
const TAP_SLOP = 4;

interface PanZoomOptions {
  stage: RefObject<HTMLElement | null>;
  minZoom: number;
  maxZoom: number;
  /** Breathing room around fitted content. */
  fitPadding: number;
  /** The most `fit` will enlarge to. 1 keeps small content at its own size. */
  maxFitZoom: number;
  onClose(): void;
  /** A press and release without a drag, in stage coordinates. */
  onTap?(point: Point): void;
  /** The pointer moved over the stage, or left it (`null`). */
  onHover?(point: Point | null): void;
  /** False to keep a double-click from zooming — where a click already acts. */
  doubleClickZoom?: boolean;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

export function usePanZoom({
  stage,
  minZoom,
  maxZoom,
  fitPadding,
  maxFitZoom,
  onClose,
  onTap,
  onHover,
  doubleClickZoom = true,
}: PanZoomOptions) {
  const pointer = useRef<Point | null>(null);
  const gesture = useRef<{ anchor: Point; scale: number } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback(
    (k: number) => Math.min(maxZoom, Math.max(minZoom, k)),
    [minZoom, maxZoom],
  );

  /** The view that centres `content` in the stage, or null before layout. */
  const fitView = useCallback(
    (content: ContentBox): View | null => {
      const box = stage.current?.getBoundingClientRect();
      if (!box) return null;
      const available = {
        width: Math.max(1, box.width - fitPadding * 2),
        height: Math.max(1, box.height - fitPadding * 2),
      };
      const k = clamp(
        Math.min(
          available.width / content.width,
          available.height / content.height,
          maxFitZoom,
        ),
      );
      return {
        x: (box.width - content.width * k) / 2 - content.x * k,
        y: (box.height - content.height * k) / 2 - content.y * k,
        k,
      };
    },
    [stage, fitPadding, maxFitZoom, clamp],
  );

  /** Centre `content` in the stage. */
  const fitTo = useCallback(
    (content: ContentBox) => {
      const fitted = fitView(content);
      if (fitted) setView(fitted);
    },
    [fitView],
  );

  /** Zoom about a point in stage coordinates, so whatever is under the cursor
   * stays under the cursor. Zooming about the centre instead makes following a
   * branch outwards a game of chase-the-node. */
  const zoomAt = useCallback(
    (factor: number, point?: Point) => {
      setView((current) => {
        if (!current) return current;
        const k = clamp(current.k * factor);
        if (k === current.k) return current;
        const box = stage.current?.getBoundingClientRect();
        const anchor = point ?? {
          x: (box?.width ?? 0) / 2,
          y: (box?.height ?? 0) / 2,
        };
        const scale = k / current.k;
        return {
          k,
          x: anchor.x - (anchor.x - current.x) * scale,
          y: anchor.y - (anchor.y - current.y) * scale,
        };
      });
    },
    [stage, clamp],
  );

  /**
   * Wheel handling, bound natively because React's `onWheel` is passive and
   * cannot call `preventDefault` — without which a trackpad pinch zooms the
   * whole webview instead of the content.
   *
   * Chromium sends a pinch as a wheel event with `ctrlKey` set. macOS WebKit
   * can instead send Safari's gesture events, whose scale is cumulative and
   * whose cursor coordinates are unreliable. For those, the pointer position
   * captured by the stage is the stable zoom anchor.
   */
  useEffect(() => {
    const element = stage.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        // WebKit may emit both streams for the same pinch.
        if (gesture.current) return;
        // The delta is clamped before it becomes a factor. A trackpad pinch
        // arrives as a stream of small deltas and is unaffected; a mouse wheel
        // notch can be 120 or more in one event, and unclamped that is a jump
        // of several hundred percent from one click of the wheel.
        const delta = Math.max(-40, Math.min(40, event.deltaY));
        zoomAt(
          Math.exp(-delta / 180),
          pointer.current ?? {
            x: event.clientX - box.left,
            y: event.clientY - box.top,
          },
        );
      } else {
        setView((current) =>
          current
            ? { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }
            : current,
        );
      }
    };

    const onGestureStart = (event: Event) => {
      event.preventDefault();
      const scale = 'scale' in event && typeof event.scale === 'number' ? event.scale : 1;
      gesture.current = {
        anchor: pointer.current ?? {
          x: element.clientWidth / 2,
          y: element.clientHeight / 2,
        },
        scale,
      };
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const current = gesture.current;
      if (!current || !('scale' in event) || typeof event.scale !== 'number') return;
      zoomAt(event.scale / current.scale, current.anchor);
      current.scale = event.scale;
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gesture.current = null;
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', onGestureStart, { passive: false });
    element.addEventListener('gesturechange', onGestureChange, { passive: false });
    element.addEventListener('gestureend', onGestureEnd, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
      element.removeEventListener('gestureend', onGestureEnd);
    };
  }, [stage, zoomAt]);

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const origin = { x: event.clientX, y: event.clientY };
    const start = view;
    if (!start) return;
    const box = event.currentTarget.getBoundingClientRect();
    let moved = false;

    event.currentTarget.setPointerCapture(event.pointerId);

    const move = (current: PointerEvent) => {
      const dx = current.clientX - origin.x;
      const dy = current.clientY - origin.y;
      if (!moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      if (!moved) {
        moved = true;
        setDragging(true);
      }
      setView({ ...start, x: start.x + dx, y: start.y + dy });
    };
    const end = (current: PointerEvent) => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (!moved && current.type === 'pointerup') {
        onTap?.({ x: origin.x - box.left, y: origin.y - box.top });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  const stageProps = {
    onPointerDown,
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const box = event.currentTarget.getBoundingClientRect();
      pointer.current = { x: event.clientX - box.left, y: event.clientY - box.top };
      onHover?.(pointer.current);
    },
    onPointerLeave() {
      pointer.current = null;
      onHover?.(null);
    },
    onDoubleClick(event: ReactMouseEvent<HTMLElement>) {
      if (!doubleClickZoom) return;
      const box = stage.current?.getBoundingClientRect();
      if (!box) return;
      zoomAt(ZOOM_STEP * ZOOM_STEP, {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    },
  };

  /**
   * The keys, for the caller to bind once it knows what `0` should fit. Typing
   * in a field keeps its characters: only Escape reaches through, because a
   * "0" or a "-" typed into a search box is a character, not a zoom.
   */
  const handleKey = useCallback(
    (event: KeyboardEvent, fit: () => void): boolean => {
      if (event.key === 'Escape') {
        onClose();
      } else if (isTyping(event.target)) {
        return false;
      } else if (event.key === '+' || event.key === '=') {
        zoomAt(ZOOM_STEP);
      } else if (event.key === '-' || event.key === '_') {
        zoomAt(1 / ZOOM_STEP);
      } else if (event.key === '0') {
        fit();
      } else {
        return false;
      }
      event.preventDefault();
      return true;
    },
    [onClose, zoomAt],
  );

  return { view, setView, dragging, fitTo, fitView, zoomAt, stageProps, handleKey };
}
