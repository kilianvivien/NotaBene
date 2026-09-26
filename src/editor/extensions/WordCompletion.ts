/**
 * Ghost-text completion from the course's vocabulary.
 *
 * The rest of a likely word is drawn after the caret in a muted colour, and
 * Tab takes it. Nothing is ever written without that keypress — this is a
 * suggestion, not an autocorrect, because the one word a completer would
 * "fix" wrongly is the unusual term the student meant.
 *
 * Built like `Abbreviation`, and for the same reasons: a plugin configured by
 * getters, because the vocabulary and the settings change while a note is
 * open, and an accepted completion is one transaction so one undo takes it
 * back. What it adds is care about the keys and moments it must stay out of:
 *
 * - The suggestion is worked out inside the transaction of the keystroke that
 *   caused it, never in a second one. The editor component re-renders on every
 *   transaction, and a follow-up dispatch per keystroke would double that.
 * - It appears only after typing. Moving the caret into a word with the mouse
 *   or the arrow keys shows nothing; so does any edit that is not plain text
 *   landing at the caret — a paste, an undo, an agent's write.
 * - Tab is claimed only while a suggestion is on screen. Lists, tables and
 *   task items all indent on Tab, and with nothing suggested it reaches them
 *   exactly as before.
 * - It stands aside while text is being composed. macOS composes accents
 *   (`^` then `e`), and an input method composes whole words; a widget
 *   changing beside the caret mid-composition can break it.
 * - It stands aside where the slash menu and the `[[` link menu are open, in
 *   code, and where the word is an abbreviation trigger, because that
 *   expansion is what the student asked for.
 */
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Abbreviation as AbbreviationRule } from '@/lib/adapters';
import type { CompletionIndex } from '@/lib/vocabulary/completionIndex';
import {
  adaptCase,
  codePointLength,
  foldKey,
  isVocabularyWordCharacter,
  wordAtEnd,
} from '@/lib/vocabulary/text';

export interface WordCompletionSettings {
  enabled: boolean;
  minPrefix: number;
}

export interface WordCompletionOptions {
  /** The open note's vocabulary, or `null` while it is still being built. */
  resolve(): CompletionIndex | null;
  settings(): WordCompletionSettings;
  /** Abbreviation triggers win over completion for their exact word. */
  triggers(): readonly AbbreviationRule[];
}

/** What is on screen: the word typed so far and the term it would become. */
export interface CompletionSuggestion {
  /** Start of the typed word. */
  from: number;
  /** The caret, at the end of the typed word. */
  to: number;
  typed: string;
  /** The whole term, cased to match what was typed. */
  term: string;
  /** The part drawn as ghost text. */
  rest: string;
}

interface CompletionState {
  suggestion: CompletionSuggestion | null;
  /** Start of a word the student dismissed with Escape. Suggesting for it
   * again on the next letter would make Escape pointless. */
  dismissedFrom: number | null;
  /** The span an accepted completion just wrote, marked briefly. */
  flash: DecorationSet;
}

type CompletionMeta =
  | { type: 'dismiss' }
  | { type: 'accept'; from: number; to: number }
  | { type: 'clearFlash' };

export const wordCompletionPluginKey = new PluginKey<CompletionState>('wordCompletion');

/** Matched to the abbreviation flash, so the two read as one behaviour. */
const FLASH_MS = 900;

/** How much of the block before the caret is read to find the word. */
const LOOKBEHIND = 64;

/** `/query` and `[[query` open menus of their own. */
const SLASH_QUERY = /(?:^|\s)\/[^\s/]*$/;
const WIKI_QUERY = /\[\[[^\]\n]*$/;

const EMPTY: CompletionState = {
  suggestion: null,
  dismissedFrom: null,
  flash: DecorationSet.empty,
};

/** The suggestion currently on screen, for commands that act on it. */
export function currentCompletion(state: EditorState): CompletionSuggestion | null {
  return wordCompletionPluginKey.getState(state)?.suggestion ?? null;
}

/**
 * Plain text typed at the caret, and nothing else: one step, inserting (or
 * replacing a selection with) text, leaving an empty selection just after it.
 */
function isTypedText(tr: Transaction, state: EditorState): boolean {
  if (tr.steps.length !== 1 || tr.getMeta('uiEvent') || tr.getMeta('paste')) return false;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep)) return false;
  const { content } = step.slice;
  if (content.childCount !== 1 || !content.firstChild?.isText) return false;
  const { selection } = state;
  return selection.empty && selection.head === step.from + content.size;
}

function computeSuggestion(
  state: EditorState,
  options: WordCompletionOptions,
): CompletionSuggestion | null {
  const settings = options.settings();
  if (!settings.enabled) return null;

  const { $head } = state.selection;
  const parent = $head.parent;
  // Code is quoted verbatim, the same rule abbreviations follow.
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if ($head.marks().some((mark) => mark.type.name === 'code')) return null;

  const offset = $head.parentOffset;
  // Mid-word: completing would push the rest of the word along.
  const after = parent.textBetween(
    offset,
    Math.min(parent.content.size, offset + 1),
    '',
    '\ufffc',
  );
  if (after && isVocabularyWordCharacter(after)) return null;

  const before = parent.textBetween(
    Math.max(0, offset - LOOKBEHIND),
    offset,
    '',
    '\ufffc',
  );
  if (SLASH_QUERY.test(before) || WIKI_QUERY.test(before)) return null;

  const typed = wordAtEnd(before);
  if (!typed || codePointLength(typed) < settings.minPrefix) return null;

  const entry = options.resolve()?.complete(typed);
  if (!entry) return null;
  // After the lookup, so the common keystroke — nothing to suggest — never
  // walks the abbreviation list. Matched as abbreviations match: ignoring case.
  const lower = typed.toLocaleLowerCase();
  if (options.triggers().some((rule) => rule.trigger.toLocaleLowerCase() === lower)) {
    return null;
  }
  const typedKey = foldKey(typed);

  // Casing can change a term's length ("ß" → "SS"); fall back to the stored
  // spelling rather than cut the ghost text at the wrong character.
  let term = adaptCase(entry.term, typed);
  if (!foldKey(term).startsWith(typedKey)) term = entry.term;
  const rest = [...term].slice(codePointLength(typed)).join('');
  if (!rest) return null;

  return { from: $head.pos - typed.length, to: $head.pos, typed, term, rest };
}

function ghostWidget(rest: string): () => HTMLElement {
  return () => {
    const ghost = document.createElement('span');
    ghost.className = 'nb-completion-ghost';
    ghost.textContent = rest;
    // Read-aloud and VoiceOver must hear the note, not a guess about it.
    ghost.setAttribute('aria-hidden', 'true');
    ghost.contentEditable = 'false';
    return ghost;
  };
}

export const WordCompletion = Extension.create<WordCompletionOptions>({
  name: 'wordCompletion',

  // Ahead of the list and table keymaps, which also want Tab. The handler
  // below declines Tab whenever nothing is suggested, so they still get it.
  priority: 1000,

  addOptions() {
    return {
      resolve: () => null,
      settings: () => ({ enabled: false, minPrefix: 3 }),
      triggers: () => [],
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    // Per editor, not per module: two editors on screen compose separately.
    let composing = false;

    return [
      new Plugin<CompletionState>({
        key: wordCompletionPluginKey,

        state: {
          init: () => EMPTY,
          apply(tr, previous, _oldState, newState): CompletionState {
            const meta = tr.getMeta(wordCompletionPluginKey) as
              CompletionMeta | undefined;

            let flash = previous.flash.map(tr.mapping, tr.doc);
            if (meta?.type === 'clearFlash') flash = DecorationSet.empty;
            if (meta?.type === 'accept') {
              flash = DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, { class: 'nb-completion-flash' }),
              ]);
            }

            let dismissedFrom =
              previous.dismissedFrom === null
                ? null
                : tr.mapping.mapResult(previous.dismissedFrom).deleted
                  ? null
                  : tr.mapping.map(previous.dismissedFrom);

            if (meta?.type === 'dismiss') {
              return {
                suggestion: null,
                dismissedFrom: previous.suggestion?.from ?? dismissedFrom,
                flash,
              };
            }

            const typing =
              !composing &&
              !tr.getMeta('composition') &&
              editor.isEditable &&
              isTypedText(tr, newState);
            let suggestion = typing ? computeSuggestion(newState, options) : null;
            if (suggestion && suggestion.from !== dismissedFrom) dismissedFrom = null;
            if (suggestion && suggestion.from === dismissedFrom) suggestion = null;

            return { suggestion, dismissedFrom, flash };
          },
        },

        props: {
          decorations(state) {
            const plugin = wordCompletionPluginKey.getState(state);
            if (!plugin) return null;
            const { suggestion, flash } = plugin;
            // `null` rather than an empty set: nothing to draw is the common
            // case, on every transaction.
            if (!suggestion) return flash.find().length ? flash : null;
            return flash.add(state.doc, [
              // `side: 2` puts it after concentration mode's block caret,
              // which sits at the same position with `side: 1`.
              Decoration.widget(suggestion.to, ghostWidget(suggestion.rest), {
                key: `nb-completion-${suggestion.rest}`,
                side: 2,
                ignoreSelection: true,
                marks: [],
              }),
            ]);
          },

          handleKeyDown(view, event) {
            if (event.isComposing || composing) return false;
            const suggestion = currentCompletion(view.state);
            if (!suggestion) return false;
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
              return false;
            }

            if (event.key === 'Tab') {
              accept(view, suggestion);
              return true;
            }
            if (event.key === 'Escape') {
              view.dispatch(
                view.state.tr
                  .setMeta(wordCompletionPluginKey, {
                    type: 'dismiss',
                  } satisfies CompletionMeta)
                  .setMeta('addToHistory', false),
              );
              // Escape also leaves concentration mode, from a window listener.
              // Dismissing a suggestion is all this press should do.
              event.stopPropagation();
              return true;
            }
            return false;
          },

          handleDOMEvents: {
            compositionstart() {
              composing = true;
              return false;
            },
            compositionend() {
              composing = false;
              return false;
            },
          },
        },
      }),
    ];
  },
});

function accept(view: EditorView, suggestion: CompletionSuggestion): void {
  const end = suggestion.from + suggestion.term.length;
  // Its own history event, so undo takes back the completion and not the
  // letters typed just before it.
  const tr = closeHistory(view.state.tr)
    .insertText(suggestion.term, suggestion.from, suggestion.to)
    .setMeta(wordCompletionPluginKey, {
      type: 'accept',
      from: suggestion.from,
      to: end,
    } satisfies CompletionMeta);
  view.dispatch(tr);
  window.setTimeout(() => {
    if (view.isDestroyed) return;
    view.dispatch(
      view.state.tr
        .setMeta(wordCompletionPluginKey, { type: 'clearFlash' } satisfies CompletionMeta)
        .setMeta('addToHistory', false),
    );
  }, FLASH_MS);
}

/** Take the suggestion off screen, as Escape does. For commands that act on
 * the word it was suggesting. */
export function dismissWordCompletion(view: EditorView): void {
  if (view.isDestroyed || !currentCompletion(view.state)) return;
  view.dispatch(
    view.state.tr
      .setMeta(wordCompletionPluginKey, { type: 'dismiss' } satisfies CompletionMeta)
      .setMeta('addToHistory', false),
  );
}
