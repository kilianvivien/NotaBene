/**
 * Anchors from what the student typed to the moment it was said (plan §10.0).
 *
 * While a lecture is being recorded in this note, a paragraph or heading the
 * student *starts* remembers the recording and the offset into it. That is the
 * whole feature: afterwards, a quiet marker beside the block plays the lecture
 * from just before that moment — "he said this would be on the exam", and here
 * is what he actually said.
 *
 * Rules, each for a reason:
 *
 * - **Set once, when the block is first typed into.** A block that goes from
 *   empty to holding a few characters in one transaction. Later edits never
 *   move the anchor — the moment a thought was written down is the moment it
 *   was said, not the moment a typo was fixed.
 * - **Only typing.** Pasted and dropped blocks lose any anchor they carry, and
 *   a transaction that inserts a paragraph's worth of text (a definition, an
 *   excerpt, anything an AI feature wrote) is not a keystroke. Neither was
 *   heard in the room.
 * - **Not inherited on Enter** (`keepOnSplit: false`). The tail of a split
 *   block was written earlier, whenever that was.
 * - **Only in the note the recording started in**, checked on every
 *   keystroke — this editor instance may outlive the note it was created for.
 *
 * The attribute is structural data in the document JSON, the way a heading's
 * `writingTarget` is, so it needed no `SCHEMA_VERSION` bump. Exports drop it
 * (`docs/export-fidelity.md`).
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Fragment, Slice } from '@tiptap/pm/model';
import {
  formatOffset,
  parseAudioAnchor,
  type AudioAnchor,
} from '@/lib/recording/anchors';

export {
  formatOffset,
  LEAD_IN_MS,
  parseAudioAnchor,
  type AudioAnchor,
} from '@/lib/recording/anchors';

export interface LectureAnchorsOptions {
  /** The recording running now, or `null`. Read on every keystroke. */
  active(): { recordingId: string; noteId: string; startedAt: number } | null;
  /** The id of the note this editor is showing. */
  noteId(): string | null;
  /** Recordings that exist as attachments on this note — only their anchors
   * get a marker; one whose audio was removed stays quiet. */
  available(): ReadonlySet<string>;
  play(anchor: AudioAnchor): void;
  label(offsetMs: number): string;
}

export const ANCHORED_TYPES = ['paragraph', 'heading'] as const;

export const lectureAnchorsPluginKey = new PluginKey<DecorationSet>('lectureAnchors');

/** More than this in one transaction is an insertion, not typing. Generous
 * enough for a smart-quote or an abbreviation expanding under the cursor. */
const TYPED_LIMIT = 24;

function isTyping(transactions: readonly Transaction[]): boolean {
  if (!transactions.some((tr) => tr.docChanged)) return false;
  return !transactions.some(
    (tr) =>
      tr.getMeta('paste') ||
      tr.getMeta('uiEvent') === 'paste' ||
      tr.getMeta('uiEvent') === 'drop' ||
      tr.getMeta('preventUpdate') ||
      tr.getMeta('addToHistory') === false,
  );
}

function stripAnchors(fragment: Fragment): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    const content = stripAnchors(node.content);
    const attrs =
      node.attrs.audioAnchor != null ? { ...node.attrs, audioAnchor: null } : node.attrs;
    nodes.push(
      attrs === node.attrs && content === node.content
        ? node
        : node.type.create(attrs, content, node.marks),
    );
  });
  return Fragment.fromArray(nodes);
}

function markers(doc: ProseMirrorNode, options: LectureAnchorsOptions): DecorationSet {
  const available = options.available();
  if (!available.size) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return true;
    const anchor = parseAudioAnchor(node.attrs.audioAnchor);
    if (anchor && available.has(anchor.recordingId)) {
      decorations.push(
        Decoration.widget(position + 1, () => markerElement(anchor, options), {
          side: -1,
          ignoreSelection: true,
          key: `anchor-${anchor.recordingId}-${anchor.offsetMs}`,
          stopEvent: () => true,
        }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function markerElement(anchor: AudioAnchor, options: LectureAnchorsOptions): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nb-audio-anchor';
  button.contentEditable = 'false';
  const label = options.label(anchor.offsetMs);
  button.setAttribute('aria-label', label);
  button.title = label;
  // A play triangle drawn in CSS: no icon font, and nothing for a screen
  // reader to announce beyond the label.
  button.innerHTML = '<span aria-hidden="true"></span>';
  // Keep the caret where it was: the student is listening, not editing.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    options.play(anchor);
  });
  return button;
}

export const LectureAnchors = Extension.create<LectureAnchorsOptions>({
  name: 'lectureAnchors',

  addOptions() {
    return {
      active: () => null,
      noteId: () => null,
      available: () => new Set<string>(),
      play: () => undefined,
      label: formatOffset,
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: [...ANCHORED_TYPES],
        attributes: {
          audioAnchor: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) =>
              parseAudioAnchor(element.getAttribute('data-audio-anchor')),
            renderHTML: (attributes) => {
              const anchor = parseAudioAnchor(attributes.audioAnchor);
              return anchor
                ? { 'data-audio-anchor': `${anchor.recordingId}@${anchor.offsetMs}` }
                : {};
            },
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<DecorationSet>({
        key: lectureAnchorsPluginKey,
        state: {
          init: (_, state) => markers(state.doc, options),
          apply(tr, previous, _old, state) {
            // Rebuilt on a nudge (a recording was kept or removed) or an edit;
            // otherwise only mapped, so moving the caret costs nothing.
            if (tr.getMeta(lectureAnchorsPluginKey) || tr.docChanged) {
              return markers(state.doc, options);
            }
            return previous;
          },
        },
        props: {
          decorations: (state) => lectureAnchorsPluginKey.getState(state),
          transformPasted: (slice: Slice) =>
            new Slice(stripAnchors(slice.content), slice.openStart, slice.openEnd),
        },
        appendTransaction(transactions, oldState, newState) {
          const active = options.active();
          if (!active || active.noteId !== options.noteId()) return null;
          if (!isTyping(transactions)) return null;

          const $head = newState.selection.$head;
          const block = $head.parent;
          if (
            !(ANCHORED_TYPES as readonly string[]).includes(block.type.name) ||
            block.attrs.audioAnchor != null ||
            !block.textContent.trim() ||
            block.textContent.length > TYPED_LIMIT
          ) {
            return null;
          }
          // First typed into: the block the caret was in was empty a moment
          // ago. A block the caret merely moved into already had its words.
          if (oldState.selection.$head.parent.content.size !== 0) return null;

          const offsetMs = Math.max(0, Math.round(Date.now() - active.startedAt));
          return newState.tr.setNodeAttribute($head.before(), 'audioAnchor', {
            recordingId: active.recordingId,
            offsetMs,
          });
        },
      }),
    ];
  },
});

export function refreshLectureAnchors(view: {
  state: { tr: Transaction };
  dispatch(tr: Transaction): void;
}): void {
  view.dispatch(
    view.state.tr.setMeta(lectureAnchorsPluginKey, true).setMeta('addToHistory', false),
  );
}
