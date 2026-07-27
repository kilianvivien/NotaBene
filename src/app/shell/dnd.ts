/**
 * Dragging things around the shell.
 *
 * Three rules, and everything else follows from them:
 *
 * 1. **The payload is typed.** A note, a course and a section each travel under
 *    their own MIME type. `dataTransfer.getData` is deliberately unreadable
 *    during `dragover` — only the *type list* is — so a drop target that wants
 *    to know whether it should light up has no other way to ask. The old code
 *    could not tell a note from a course mid-drag, which is why dragging a note
 *    over a course reordered the courses instead.
 * 2. **Hover state is counted, not toggled.** `dragenter`/`dragleave` fire for
 *    every child element under the pointer, so a row with an icon and a label in
 *    it flickers if you treat `dragleave` as "the pointer left". A depth counter
 *    is the standard fix and the only one that survives nested content.
 * 3. **A target that will not accept the drag never calls `preventDefault`.**
 *    That is what makes the cursor show "no drop" instead of promising something
 *    the drop handler is then going to ignore.
 */
import { useCallback, useRef, useState, type DragEvent } from 'react';

export const NOTE_MIME = 'application/x-notabene-note-id';
export const COURSE_MIME = 'application/x-notabene-course-id';
export const SECTION_MIME = 'application/x-notabene-section-id';

export type DragKind = 'note' | 'course' | 'section';

const MIME_FOR: Record<DragKind, string> = {
  note: NOTE_MIME,
  course: COURSE_MIME,
  section: SECTION_MIME,
};

/**
 * Start a drag of one of our own things.
 *
 * `text/plain` rides along so a note dropped outside the app pastes something
 * meaningful, but every in-app target reads the typed entry.
 */
export function startDrag(
  event: DragEvent,
  kind: DragKind,
  id: string,
  label?: string,
): void {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(MIME_FOR[kind], id);
  event.dataTransfer.setData('text/plain', label ?? id);
}

/** Whether a drag in flight carries the given kind. Safe to call in
 * `dragover`, where the values themselves are hidden. */
export function dragCarries(event: DragEvent, kind: DragKind): boolean {
  return event.dataTransfer.types.includes(MIME_FOR[kind]);
}

/** The id a drop carries, or `null`. Only meaningful in `drop`. */
export function readDrag(event: DragEvent, kind: DragKind): string | null {
  return event.dataTransfer.getData(MIME_FOR[kind]) || null;
}

export interface DropTargetOptions {
  /** Kinds this target will take. Anything else passes straight through to
   * whatever is underneath. */
  accepts: DragKind[];
  onDrop(kind: DragKind, id: string, event: DragEvent): void;
  /** Rejects a specific drag that is otherwise the right kind — a course
   * refusing a note that already lives in it, say. */
  canDrop?(kind: DragKind, event: DragEvent): boolean;
  effect?: 'move' | 'copy';
  disabled?: boolean;
}

export interface DropTarget {
  /** True while an acceptable drag is over this target. Drive the highlight
   * from this and nothing else, so the affordance cannot disagree with what a
   * drop would actually do. */
  active: boolean;
  handlers: {
    onDragEnter(event: DragEvent): void;
    onDragOver(event: DragEvent): void;
    onDragLeave(event: DragEvent): void;
    onDrop(event: DragEvent): void;
  };
}

export function useDropTarget(options: DropTargetOptions): DropTarget {
  const { accepts, onDrop, canDrop, effect = 'move', disabled = false } = options;
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  const kindOf = useCallback(
    (event: DragEvent): DragKind | null => {
      if (disabled) return null;
      const kind = accepts.find((candidate) => dragCarries(event, candidate));
      if (!kind) return null;
      return canDrop && !canDrop(kind, event) ? null : kind;
    },
    // `accepts` is written inline at every call site, so comparing by identity
    // would rebuild this on every render. The contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled, canDrop, accepts.join(',')],
  );

  const reset = useCallback(() => {
    depth.current = 0;
    setActive(false);
  }, []);

  return {
    active,
    handlers: {
      onDragEnter(event) {
        if (!kindOf(event)) return;
        event.preventDefault();
        depth.current += 1;
        setActive(true);
      },
      onDragOver(event) {
        if (!kindOf(event)) return;
        // Claiming the drag stops an ancestor target from also lighting up.
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = effect;
      },
      onDragLeave(event) {
        if (!kindOf(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      },
      onDrop(event) {
        const kind = kindOf(event);
        reset();
        if (!kind) return;
        event.preventDefault();
        event.stopPropagation();
        const id = readDrag(event, kind);
        if (id) onDrop(kind, id, event);
      },
    },
  };
}
