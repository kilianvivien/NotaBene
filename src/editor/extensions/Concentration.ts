/**
 * The mechanics of concentration mode, inside the editor.
 *
 * Three things a typewriter does that a text box does not: it keeps the line
 * you are writing at one fixed height, it gives you a solid block of a cursor,
 * and it shows you the sentence rather than the manuscript. This is one plugin
 * because all three share a trigger — where the selection is, and whether it
 * got there from the keyboard.
 *
 * Configured through a getter rather than plain options, for the reason
 * `Abbreviation` is: the extension list is memoised for the life of an editor,
 * and these settings are changed in a modal while a note is open.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';

export interface ConcentrationState {
  /** Concentration mode is on. Everything here is inert otherwise. */
  active: boolean;
  lineFocus: 'off' | 'paragraph';
  blockCaret: boolean;
  typewriterScrolling: boolean;
}

export interface ConcentrationOptions {
  /** Read on every update, never cached. */
  resolve(): ConcentrationState;
}

export const concentrationPluginKey = new PluginKey('concentration');

/** Where the caret's line sits in the scroller, as a fraction of its height.
 * Overridable from CSS so the reading rhythm stays in `tokens.css`. */
const DEFAULT_ANCHOR = 0.42;

/**
 * How long after a keystroke a selection change still counts as typing.
 *
 * A click must never pin the line. That was the flaw in the old
 * `scrollIntoView({ block: 'center' })`: putting the cursor somewhere with the
 * mouse animated the whole page out from under the pointer.
 */
const KEYBOARD_GRACE_MS = 250;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * The textblock holding the selection head, not the top-level node.
 *
 * A paragraph inside a list item is the line the student is on; the list is
 * not. Resolving to the textblock is what makes line focus useful in the
 * bulleted notes people actually take in a lecture.
 */
export function focusedBlock(state: EditorState): { from: number; to: number } | null {
  const $head = state.doc.resolve(state.selection.head);
  if ($head.depth < 1 || !$head.parent.isTextblock) return null;
  const from = $head.before($head.depth);
  return { from, to: from + $head.parent.nodeSize };
}

function blockCaretWidget(): HTMLElement {
  const caret = document.createElement('span');
  caret.className = 'nb-block-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.contentEditable = 'false';
  return caret;
}

/** Read `--nb-typewriter-anchor` off the scroller. */
export function anchorRatio(scroller: HTMLElement): number {
  const raw = getComputedStyle(scroller).getPropertyValue('--nb-typewriter-anchor');
  const percent = Number.parseFloat(raw);
  if (!Number.isFinite(percent)) return DEFAULT_ANCHOR;
  return Math.min(Math.max(percent / 100, 0.1), 0.9);
}

/**
 * Pin the caret's line at the anchor height.
 *
 * Instant, not smooth: a platen does not ease into place, and an animation on
 * every keystroke is exactly the distraction this mode exists to remove.
 */
function pinCaretLine(view: EditorView): void {
  const scroller = view.dom.closest<HTMLElement>('.nb-editor-scroll');
  if (!scroller) return;
  const caret = view.coordsAtPos(view.state.selection.head);
  const box = scroller.getBoundingClientRect();
  const target = box.top + box.height * anchorRatio(scroller);
  const delta = caret.top - target;
  // Sub-pixel corrections would fight the browser's own rounding forever.
  if (Math.abs(delta) < 1) return;
  scroller.scrollTop += delta;
}

/** Tell the toolbar there is something to format. Its reveal rule in
 * `editor.css` keys off this, which is what replaces a bubble menu without
 * adding one. */
function markSelection(view: EditorView, selecting: boolean): void {
  const editor = view.dom.closest<HTMLElement>('.nb-rich-editor');
  if (!editor) return;
  if (selecting) editor.dataset.selection = 'text';
  else delete editor.dataset.selection;
}

export const Concentration = Extension.create<ConcentrationOptions>({
  name: 'concentration',

  addOptions() {
    return {
      resolve: () => ({
        active: false,
        lineFocus: 'off',
        blockCaret: false,
        typewriterScrolling: false,
      }),
    };
  },

  addProseMirrorPlugins() {
    const { resolve } = this.options;
    /** Shared by the key handler and the view: arrow keys and Enter move the
     * caret without changing the document, and those should pin the line too. */
    let lastKeyAt = 0;

    return [
      new Plugin({
        key: concentrationPluginKey,

        props: {
          handleKeyDown() {
            lastKeyAt = Date.now();
            return false;
          },

          // Derived straight from the selection rather than held in plugin
          // state: there is nothing to remember between transactions, and a
          // settings change arriving without one is covered by the refresh
          // nudge `RichTextEditor` dispatches.
          decorations(state) {
            const config = resolve();
            if (!config.active) return null;

            const block = focusedBlock(state);
            const decorations: Decoration[] = [];

            if (block && config.lineFocus === 'paragraph') {
              decorations.push(
                Decoration.node(block.from, block.to, { class: 'nb-focus-line' }),
              );
            }

            // Whether the caret is *visible* is left to CSS: ProseMirror marks
            // the editor `.ProseMirror-focused`, which is cheaper and steadier
            // than tracking blur here.
            if (config.blockCaret && state.selection.empty) {
              decorations.push(
                Decoration.widget(state.selection.head, blockCaretWidget, {
                  key: 'nb-block-caret',
                  side: 1,
                }),
              );
            }

            if (!decorations.length) return null;
            return DecorationSet.create(state.doc, decorations);
          },
        },

        view() {
          let frame = 0;

          return {
            update(view, previous) {
              const config = resolve();
              const selectionChanged = !previous.selection.eq(view.state.selection);
              const docChanged = !previous.doc.eq(view.state.doc);

              markSelection(view, config.active && !view.state.selection.empty);

              if (!config.active || !config.typewriterScrolling) return;
              if (!docChanged && !selectionChanged) return;
              // Pinning scrolls on every keystroke, which is motion however
              // instant each step is.
              if (prefersReducedMotion()) return;
              if (!docChanged && Date.now() - lastKeyAt > KEYBOARD_GRACE_MS) return;

              // After layout, or `coordsAtPos` measures the line the caret was
              // on before the character that just moved it.
              cancelAnimationFrame(frame);
              frame = requestAnimationFrame(() => {
                if (!view.isDestroyed) pinCaretLine(view);
              });
            },

            destroy() {
              cancelAnimationFrame(frame);
            },
          };
        },
      }),
    ];
  },
});
