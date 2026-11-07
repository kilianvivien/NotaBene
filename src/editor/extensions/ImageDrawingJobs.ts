/**
 * Where each in-flight image → drawing reconstruction lives in the open note.
 *
 * A reconstruction takes long enough that the student keeps writing — above
 * the image, below it, sometimes around it — so a position captured at the
 * start is wrong by the time the model answers. This plugin follows the image
 * (and, once it lands, the drawing) through every transaction, and decorates
 * both so their node views can draw the job's state in place.
 *
 * The plugin is the authority on whether a job still has somewhere to go: an
 * entry that disappears — the image was deleted, the drawing discarded, the
 * student dismissed the bar — is reported through `onLost`, which forgets the
 * job and stops a running request. Nothing here is persisted or saved; the
 * decorations add no attribute to the document.
 */
import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, PluginKey, Selection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { locateImageTarget, type ImageDrawingTarget } from '@/lib/notes/imageTargets';
import type { DocNode, NoteDoc } from '@/lib/schema';

interface Tracked {
  image: number;
  assetId: string;
  /** The drawing this job placed, once it has. */
  drawing: number | null;
}

type Jobs = ReadonlyMap<string, Tracked>;

type Meta =
  | { track: { jobId: string; pos: number; assetId: string } }
  | { placed: { jobId: string; pos: number } }
  | { untrack: string };

export interface ImageDrawingJobsOptions {
  onLost(jobId: string): void;
}

export const imageDrawingJobsKey = new PluginKey<Jobs>('imageDrawingJobs');

/** Spec keys the node views read their job from. */
export const IMAGE_JOB_SPEC = 'imageDrawingJob';
export const DRAWING_JOB_SPEC = 'imageDrawingResult';

function isImage(node: PMNode | null | undefined, assetId: string): boolean {
  return node?.type.name === 'image' && node.attrs.assetId === assetId;
}

/**
 * Two readings of the old position, because no single association is right
 * for both common edits: text inserted just before the image needs the right
 * side, and the image's own replacement (a caption edit or a resize is a
 * `setNodeMarkup`) needs the left. Failing both, a unique copy of the same
 * asset anywhere in the note is still unambiguously it.
 */
function follow(
  doc: PMNode,
  mapping: { map(pos: number, assoc?: number): number },
  pos: number,
  matches: (node: PMNode | null | undefined) => boolean,
  fallback: (() => number | null) | null,
): number | null {
  for (const assoc of [1, -1]) {
    const mapped = mapping.map(pos, assoc);
    if (mapped <= doc.content.size && matches(doc.nodeAt(mapped))) return mapped;
  }
  return fallback?.() ?? null;
}

function uniqueImage(doc: PMNode, assetId: string): number | null {
  let found: number | null = null;
  let count = 0;
  doc.descendants((node, pos) => {
    if (isImage(node, assetId)) {
      found = pos;
      count += 1;
    }
    return count < 2;
  });
  return count === 1 ? found : null;
}

export const ImageDrawingJobs = Extension.create<ImageDrawingJobsOptions>({
  name: 'imageDrawingJobs',

  addOptions() {
    return { onLost: () => {} };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<Jobs>({
        key: imageDrawingJobsKey,
        state: {
          init: () => new Map(),
          apply(tr, value) {
            const meta = tr.getMeta(imageDrawingJobsKey) as Meta | undefined;
            if (!meta && (!tr.docChanged || value.size === 0)) return value;
            const next = new Map<string, Tracked>();
            for (const [jobId, entry] of value) {
              if (!tr.docChanged) {
                next.set(jobId, entry);
                continue;
              }
              const image = follow(
                tr.doc,
                tr.mapping,
                entry.image,
                (node) => isImage(node, entry.assetId),
                () => uniqueImage(tr.doc, entry.assetId),
              );
              if (image === null) continue;
              let drawing: number | null = null;
              if (entry.drawing !== null) {
                drawing = follow(
                  tr.doc,
                  tr.mapping,
                  entry.drawing,
                  (node) => node?.type.name === 'drawing',
                  null,
                );
                // A discarded drawing ends the job just as a deleted image does.
                if (drawing === null) continue;
              }
              next.set(jobId, { ...entry, image, drawing });
            }
            if (meta && 'track' in meta) {
              const { jobId, pos, assetId } = meta.track;
              if (isImage(tr.doc.nodeAt(pos), assetId))
                next.set(jobId, { image: pos, assetId, drawing: null });
            } else if (meta && 'placed' in meta) {
              const entry = next.get(meta.placed.jobId);
              if (entry)
                next.set(meta.placed.jobId, { ...entry, drawing: meta.placed.pos });
            } else if (meta && 'untrack' in meta) {
              next.delete(meta.untrack);
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            const jobs = imageDrawingJobsKey.getState(state);
            if (!jobs?.size) return null;
            const decorations: Decoration[] = [];
            for (const [jobId, entry] of jobs) {
              const image = state.doc.nodeAt(entry.image);
              if (image) {
                decorations.push(
                  Decoration.node(
                    entry.image,
                    entry.image + image.nodeSize,
                    {},
                    { [IMAGE_JOB_SPEC]: jobId },
                  ),
                );
              }
              const drawing =
                entry.drawing === null ? null : state.doc.nodeAt(entry.drawing);
              if (drawing && entry.drawing !== null) {
                decorations.push(
                  Decoration.node(
                    entry.drawing,
                    entry.drawing + drawing.nodeSize,
                    { class: 'nb-drawing-arrived' },
                    { [DRAWING_JOB_SPEC]: jobId },
                  ),
                );
              }
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
        view: () => ({
          update(view, previous) {
            const before = imageDrawingJobsKey.getState(previous);
            const after = imageDrawingJobsKey.getState(view.state);
            if (!before?.size || before === after) return;
            for (const jobId of before.keys()) {
              if (!after?.has(jobId)) options.onLost(jobId);
            }
          },
        }),
      }),
    ];
  },
});

export function trackedImageDrawing(
  state: EditorState,
  jobId: string,
): Readonly<Tracked> | null {
  return imageDrawingJobsKey.getState(state)?.get(jobId) ?? null;
}

/** Whether some job is already redrawing the image at `pos`. */
export function imageDrawingJobAt(state: EditorState, pos: number): string | null {
  for (const [jobId, entry] of imageDrawingJobsKey.getState(state) ?? []) {
    if (entry.image === pos) return jobId;
  }
  return null;
}

export function trackImageDrawing(view: EditorView, jobId: string, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (node?.type.name !== 'image') return false;
  const assetId = String(node.attrs.assetId);
  view.dispatch(
    view.state.tr
      .setMeta(imageDrawingJobsKey, { track: { jobId, pos, assetId } } satisfies Meta)
      .setMeta('addToHistory', false),
  );
  return trackedImageDrawing(view.state, jobId) !== null;
}

/** Stop following a job here. `onLost` then forgets it everywhere else. */
export function untrackImageDrawing(view: EditorView, jobId: string): void {
  view.dispatch(
    view.state.tr
      .setMeta(imageDrawingJobsKey, { untrack: jobId } satisfies Meta)
      .setMeta('addToHistory', false),
  );
}

function posAtPath(doc: PMNode, path: number[]): number | null {
  let pos = 0;
  let node = doc;
  for (const [depth, index] of path.entries()) {
    if (index >= node.childCount) return null;
    for (let i = 0; i < index; i += 1) pos += node.child(i).nodeSize;
    node = node.child(index);
    if (depth < path.length - 1) pos += 1;
  }
  return pos;
}

/**
 * Pick a job back up in a freshly mounted editor — the student went to another
 * note and came back while the model was still working. Finds the image the
 * same careful way the command layer does, and leaves an ambiguous one alone.
 */
export function adoptImageDrawing(
  editor: Editor,
  jobId: string,
  target: ImageDrawingTarget,
): boolean {
  if (trackedImageDrawing(editor.state, jobId)) return true;
  const found = locateImageTarget(editor.getJSON() as NoteDoc, target);
  if (!found) return false;
  const pos = posAtPath(editor.state.doc, found.path);
  return pos !== null && trackImageDrawing(editor.view, jobId, pos);
}

/**
 * Put the finished drawing directly below the image it was made from, as one
 * undoable step of its own. The caret and anything typed meanwhile are left
 * exactly where they are; that is the reason this goes through the editor
 * instead of rewriting the note from the library.
 */
export function placeImageDrawing(
  editor: Editor,
  jobId: string,
  drawing: DocNode,
): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const entry = trackedImageDrawing(editor.state, jobId);
  if (!entry) return false;
  const image = editor.state.doc.nodeAt(entry.image);
  if (!image) return false;
  const at = entry.image + image.nodeSize;
  const $at = editor.state.doc.resolve(at);
  const node = editor.schema.nodeFromJSON(drawing);
  if (!$at.parent.canReplaceWith($at.index(), $at.index(), node.type)) return false;
  const tr = closeHistory(editor.state.tr).insert(at, node);
  tr.setMeta(imageDrawingJobsKey, { placed: { jobId, pos: at } } satisfies Meta);
  editor.view.dispatch(tr);
  // Closed on both sides: a word typed within the history's grouping delay
  // must not share an undo step with the drawing.
  editor.view.dispatch(closeHistory(editor.state.tr));
  return true;
}

/** Move a node selection off the image, so the student's next keystroke goes
 * into the text after it instead of replacing the picture being redrawn. */
export function stepPastImage(editor: Editor, pos: number): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const selection = Selection.near(editor.state.doc.resolve(pos + node.nodeSize), 1);
  editor.view.dispatch(editor.state.tr.setSelection(selection));
}
