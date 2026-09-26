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
 * - It appears only after typing — plain text landing at the caret, or a
 *   Backspace inside the word being corrected. Moving the caret into a word
 *   with the mouse or the arrow keys shows nothing; so does a paste, an undo,
 *   or an agent's write.
 * - Tab is claimed only while a suggestion is on screen. Lists, tables and
 *   task items all indent on Tab, and with nothing suggested it reaches them
 *   exactly as before.
 * - It stands aside while text is being composed. macOS composes accents
 *   (`^` then `e`), and an input method composes whole words; a widget
 *   changing beside the caret mid-composition can break it.
 * - It stands aside where the slash menu and the `[[` link menu are open, in
 *   code, and where the word is an abbreviation trigger, because that
 *   expansion is what the student asked for.
 *
 * Words come from two places: the course's index, built by the vocabulary
 * cache, and a small index of the open note itself, rebuilt here whenever
 * typing pauses so a term introduced in this lecture completes minutes before
 * the course harvest would know it. Several candidates are kept, and
 * Option-Tab steps through them.
 */
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type {
  Abbreviation as AbbreviationRule,
  CompletionSettings,
} from '@/lib/adapters';
import {
  rankCompletions,
  type CompletionEntry,
  type CompletionIndex,
} from '@/lib/vocabulary/completionIndex';
import { buildNoteIndex } from '@/lib/vocabulary/noteWords';
import { presenceProfile } from '@/lib/vocabulary/presence';
import {
  adaptCase,
  codePointLength,
  foldKey,
  isVocabularyWordCharacter,
  wordAtEnd,
} from '@/lib/vocabulary/text';

export type WordCompletionSettings = CompletionSettings;

export interface WordCompletionOptions {
  /** The open note's vocabulary, or `null` while it is still being built. */
  resolve(): CompletionIndex | null;
  settings(): WordCompletionSettings;
  /** Abbreviation triggers win over completion for their exact word. */
  triggers(): readonly AbbreviationRule[];
  /** Times a folded key was accepted before, for ranking. */
  learned?(key: string): number;
  /** Told of every accepted completion, with its folded key. */
  onAccept?(key: string): void;
  /** Whether the `auto` hint still has something to teach. */
  hintWanted?(): boolean;
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
  /** Every word on offer for what was typed, best first. */
  candidates: CompletionEntry[];
  /** Which of them is on screen. */
  choice: number;
  /** Draw the Tab keycap beside the ghost text. */
  hint: boolean;
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
  | { type: 'cycle'; step: 1 | -1 }
  | { type: 'accept'; from: number; to: number }
  | { type: 'clearFlash' };

export const wordCompletionPluginKey = new PluginKey<CompletionState>('wordCompletion');

/** Matched to the abbreviation flash, so the two read as one behaviour. */
const FLASH_MS = 900;

/** How much of the block before the caret is read to find the word. */
const LOOKBEHIND = 64;

/** Alternatives kept for Option-Tab. More than this is a list to read, not a
 * word to recognise. */
const MAX_CANDIDATES = 5;

/** Typing pause before the open note's words are re-read. */
const NOTE_REBUILD_MS = 600;

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
 * An edit the student made to the word at the caret: plain text typed there
 * (one step, inserting or replacing a selection with text), or a deletion
 * inside one paragraph that leaves the caret where it happened — Backspace
 * while correcting a word should not take the suggestion away.
 */
function isTypingEdit(tr: Transaction, state: EditorState): boolean {
  if (tr.steps.length !== 1 || tr.getMeta('uiEvent') || tr.getMeta('paste')) return false;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep)) return false;
  const { selection } = state;
  if (!selection.empty) return false;
  const { content } = step.slice;
  if (content.size === 0) {
    if (step.to <= step.from || selection.head !== step.from) return false;
    return tr.docs[0]!.resolve(step.from).sameParent(tr.docs[0]!.resolve(step.to));
  }
  if (content.childCount !== 1 || !content.firstChild?.isText) return false;
  return selection.head === step.from + content.size;
}

/** The word being typed, if the caret is somewhere a suggestion may go. */
function wordAtCaret(
  state: EditorState,
  settings: WordCompletionSettings,
): string | null {
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
  return typed;
}

/** The on-screen form of candidate `choice`, or `null` if it has nothing to
 * add once cased. */
function present(
  base: Pick<CompletionSuggestion, 'from' | 'to' | 'typed' | 'candidates' | 'hint'>,
  choice: number,
): CompletionSuggestion | null {
  const entry = base.candidates[choice];
  if (!entry) return null;
  // Casing can change a term's length ("ß" → "SS"); fall back to the stored
  // spelling rather than cut the ghost text at the wrong character.
  let term = adaptCase(entry.term, base.typed);
  if (!foldKey(term).startsWith(foldKey(base.typed))) term = entry.term;
  const rest = [...term].slice(codePointLength(base.typed)).join('');
  if (!rest) return null;
  return { ...base, term, rest, choice };
}

function computeSuggestion(
  state: EditorState,
  options: WordCompletionOptions,
  noteIndex: CompletionIndex | null,
): CompletionSuggestion | null {
  const settings = options.settings();
  if (!settings.enabled) return null;

  const typed = wordAtCaret(state, settings);
  if (!typed) return null;

  const profile = presenceProfile(settings.presence);
  const candidates = rankCompletions(
    {
      course: options.resolve(),
      note: settings.fromCurrentNote ? noteIndex : null,
      learned: settings.learn ? options.learned : undefined,
    },
    typed,
    MAX_CANDIDATES,
    profile.minRest,
  );
  if (!candidates.length) return null;
  // After the lookup, so the common keystroke — nothing to suggest — never
  // walks the abbreviation list. Matched as abbreviations match: ignoring case.
  const lower = typed.toLocaleLowerCase();
  if (options.triggers().some((rule) => rule.trigger.toLocaleLowerCase() === lower)) {
    return null;
  }

  const hint =
    settings.hint === 'always' ||
    (settings.hint === 'auto' && (options.hintWanted?.() ?? false));
  const to = state.selection.head;
  return present({ from: to - typed.length, to, typed, candidates, hint }, 0);
}

/**
 * The open note's words, minus the one at the caret: a word paused on half
 * way through ("mitoch") is not a word to offer back.
 */
function noteText(state: EditorState): string {
  const { doc, selection } = state;
  const head = selection.head;
  const $head = doc.resolve(head);
  let start = head;
  if ($head.parent.isTextblock) {
    const before = $head.parent.textBetween(
      Math.max(0, $head.parentOffset - LOOKBEHIND),
      $head.parentOffset,
      '',
      '\ufffc',
    );
    start = head - wordAtEnd(before).length;
  }
  return `${doc.textBetween(0, start, '\n', ' ')} ${doc.textBetween(head, doc.content.size, '\n', ' ')}`;
}

function ghostWidget(suggestion: CompletionSuggestion): () => HTMLElement {
  return () => {
    const ghost = document.createElement('span');
    ghost.className = 'nb-completion-ghost';
    // Read-aloud and VoiceOver must hear the note, not a guess about it.
    ghost.setAttribute('aria-hidden', 'true');
    ghost.contentEditable = 'false';
    ghost.append(suggestion.rest);

    const alternatives = suggestion.candidates.length;
    // Once the student has cycled, where they are among the alternatives is
    // what they need to see, hint or no hint.
    if (suggestion.hint || suggestion.choice > 0) {
      const hint = document.createElement('span');
      hint.className = 'nb-completion-hint';
      if (suggestion.hint) {
        const key = document.createElement('kbd');
        key.textContent = 'tab';
        hint.append(key);
      }
      if (alternatives > 1) {
        const more = document.createElement('span');
        more.className = 'nb-completion-count';
        more.textContent = `${suggestion.hint ? '⌥⇥ ' : ''}${suggestion.choice + 1}/${alternatives}`;
        hint.append(more);
      }
      ghost.append(hint);
    }
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
      settings: () => ({
        enabled: false,
        minPrefix: 3,
        presence: 'balanced',
        fromCurrentNote: false,
        learn: false,
        hint: 'never',
      }),
      triggers: () => [],
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    // Per editor, not per module: two editors on screen compose separately.
    let composing = false;
    let noteIndex: CompletionIndex | null = null;
    let rebuild: ReturnType<typeof setTimeout> | undefined;

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

            if (meta?.type === 'cycle' && previous.suggestion) {
              const { candidates, choice } = previous.suggestion;
              const next = (choice + meta.step + candidates.length) % candidates.length;
              return {
                suggestion: present(previous.suggestion, next) ?? previous.suggestion,
                dismissedFrom,
                flash,
              };
            }

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
              isTypingEdit(tr, newState);
            let suggestion = typing
              ? computeSuggestion(newState, options, noteIndex)
              : null;
            if (suggestion && suggestion.from !== dismissedFrom) dismissedFrom = null;
            if (suggestion && suggestion.from === dismissedFrom) suggestion = null;

            return { suggestion, dismissedFrom, flash };
          },
        },

        view(view) {
          const schedule = () => {
            clearTimeout(rebuild);
            const settings = options.settings();
            if (!settings.enabled || !settings.fromCurrentNote) {
              noteIndex = null;
              return;
            }
            rebuild = setTimeout(() => {
              if (view.isDestroyed) return;
              noteIndex = buildNoteIndex(
                noteText(view.state),
                presenceProfile(options.settings().presence),
              );
            }, NOTE_REBUILD_MS);
          };
          schedule();
          return {
            update(current, previous) {
              if (!current.state.doc.eq(previous.doc)) schedule();
            },
            destroy() {
              clearTimeout(rebuild);
            },
          };
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
              Decoration.widget(suggestion.to, ghostWidget(suggestion), {
                key: `nb-completion-${suggestion.rest}-${suggestion.choice}-${suggestion.hint}`,
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
            if (event.metaKey || event.ctrlKey) return false;

            // Option-Tab / Option-↓ step through the alternatives, with Shift
            // or ↑ going back. Claimed only while there is more than one.
            if (event.altKey && suggestion.candidates.length > 1) {
              const step =
                event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)
                  ? 1
                  : event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)
                    ? -1
                    : 0;
              if (step) {
                view.dispatch(
                  view.state.tr
                    .setMeta(wordCompletionPluginKey, {
                      type: 'cycle',
                      step,
                    } satisfies CompletionMeta)
                    .setMeta('addToHistory', false),
                );
                return true;
              }
            }
            if (event.altKey || event.shiftKey) return false;

            if (event.key === 'Tab') {
              accept(view, suggestion);
              options.onAccept?.(suggestion.candidates[suggestion.choice]?.key ?? '');
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
