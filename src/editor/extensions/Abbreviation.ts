/**
 * Typing shortcuts, expanded as the note is written.
 *
 * A plugin rather than input rules: TipTap compiles input rules once, when the
 * editor is created, and this list changes in Settings while a note is open.
 * Resolving it per keystroke keeps a saved abbreviation working immediately
 * without tearing the editor — and its undo history — down and rebuilding it.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Abbreviation as AbbreviationRule } from '@/lib/adapters';
import {
  MAX_TRIGGER_LENGTH,
  endsWord,
  matchAbbreviation,
} from '@/lib/notes/abbreviations';

export interface AbbreviationOptions {
  /** Read at expansion time, never cached. */
  resolve(): readonly AbbreviationRule[];
}

/** How long the expanded words stay marked. Long enough to catch the eye at
 * typing speed, short enough that it is gone before the next sentence. */
const FLASH_MS = 900;

export const abbreviationPluginKey = new PluginKey<DecorationSet>('abbreviation');

/** The range an expansion just wrote, or `null` to clear the mark. */
type FlashMeta = { from: number; to: number } | null;

/**
 * Rewrite the trigger that ends at `pos`, if there is one. Works on a
 * transaction rather than a state so the expansion and the keystroke that
 * committed it land as a single step — one undo takes the abbreviation back.
 */
function expandBefore(
  tr: Transaction,
  pos: number,
  rules: readonly AbbreviationRule[],
): boolean {
  const $pos = tr.doc.resolve(pos);
  // Code is quoted verbatim; silently rewriting an identifier inside a code
  // block would be a bug the student cannot see the cause of.
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return false;
  if ($pos.marks().some((mark) => mark.type.name === 'code')) return false;

  const from = Math.max(0, $pos.parentOffset - MAX_TRIGGER_LENGTH);
  // `￼` stands in for inline atoms — a wiki link, an inline equation — so a
  // trigger cannot be matched across one.
  const textBefore = $pos.parent.textBetween(from, $pos.parentOffset, undefined, '￼');
  const match = matchAbbreviation(textBefore, rules);
  if (!match) return false;

  const start = pos - (textBefore.length - match.start);
  tr.insertText(match.replacement, start, pos);
  const flash: FlashMeta = { from: start, to: start + match.replacement.length };
  tr.setMeta(abbreviationPluginKey, flash);
  return true;
}

/**
 * Take the mark off again. A separate, history-free transaction: the flash is
 * a hint about what just happened, and undoing the expansion should give the
 * abbreviation back, not replay the highlight.
 */
function scheduleClear(view: EditorView): void {
  window.setTimeout(() => {
    if (view.isDestroyed) return;
    if (!abbreviationPluginKey.getState(view.state)?.find().length) return;
    const clear: FlashMeta = null;
    view.dispatch(
      view.state.tr.setMeta(abbreviationPluginKey, clear).setMeta('addToHistory', false),
    );
  }, FLASH_MS);
}

export const Abbreviation = Extension.create<AbbreviationOptions>({
  name: 'abbreviation',

  addOptions() {
    return { resolve: () => [] };
  },

  addProseMirrorPlugins() {
    const { resolve } = this.options;

    return [
      new Plugin<DecorationSet>({
        key: abbreviationPluginKey,

        // The expanded words carry a short-lived mark, so a student sees which
        // text the app wrote for them. Without it an expansion mid-sentence
        // reads as a typo they made themselves.
        state: {
          init: () => DecorationSet.empty,
          apply(tr, current) {
            const flash = tr.getMeta(abbreviationPluginKey) as FlashMeta | undefined;
            if (flash === null) return DecorationSet.empty;
            if (flash) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(flash.from, flash.to, { class: 'nb-abbr-flash' }),
              ]);
            }
            return current.map(tr.mapping, tr.doc);
          },
        },

        props: {
          decorations: (state) => abbreviationPluginKey.getState(state),

          handleTextInput(view, from, to, text, insertDefault) {
            // An expansion commits when the word ends, the way macOS text
            // replacement does: expanding mid-word would rewrite a prefix the
            // user is still typing past.
            if (!endsWord(text)) return false;
            const rules = resolve();
            if (!rules.length) return false;

            // Insert what was typed first, then look behind the terminator.
            // ProseMirror hands us several characters at once often enough —
            // fast typing, an IME commit — that matching against `text` as a
            // single keystroke would miss those.
            const tr = insertDefault
              ? insertDefault()
              : view.state.tr.insertText(text, from, to);
            if (!expandBefore(tr, from + text.length - 1, rules)) return false;
            view.dispatch(tr);
            scheduleClear(view);
            return true;
          },

          handleKeyDown(view, event) {
            if (event.key !== 'Enter' || event.isComposing) return false;
            const rules = resolve();
            if (!rules.length) return false;
            const { selection } = view.state;
            if (!selection.empty) return false;

            // Expand, then let Enter run against the updated state: the break
            // itself is the boundary, so it is not ours to insert.
            const tr = view.state.tr;
            if (!expandBefore(tr, selection.from, rules)) return false;
            view.dispatch(tr);
            scheduleClear(view);
            return false;
          },
        },
      }),
    ];
  },
});
