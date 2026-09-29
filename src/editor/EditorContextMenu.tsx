/**
 * The editor's right-click menu, built to behave like a macOS text view's.
 *
 * What a context click does to the selection is the part that decides whether
 * it feels native, so it follows AppKit rather than the browser:
 *
 * - inside the selection, the selection stays;
 * - on a word, that word is selected, so Copy, Define and the formatting row
 *   act on what was clicked;
 * - anywhere else (a gap, past the end of a line) the caret moves there.
 *
 * The browser's own right-mousedown is cancelled so WebKit and Chromium do not
 * each apply their own rule first. ⇧-right-click is left entirely to the
 * system, which is where spelling suggestions live.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useTranslation } from 'react-i18next';
import {
  Bold,
  Italic,
  Underline,
  Highlighter,
  Link2,
  Link2Off,
  ExternalLink,
  Scissors,
  Copy,
  ClipboardPaste,
  ClipboardType,
  TextSelect,
  SpellCheck2,
  PenLine,
  BookA,
  BookPlus,
  CalendarDays,
} from 'lucide-react';
import {
  ContextMenu,
  type ContextMenuEntry,
  type ContextPoint,
  type ContextToolbarItem,
} from '@/components/glass';
import {
  APP_COMMANDS,
  runAppCommand,
  type AppCommandId,
} from '@/lib/commands/appCommands';
import { commandShortcut } from '@/app/shell/useCommandSearch';
import { externalLinks } from '@/lib/adapters';
import { useUiStore } from '@/lib/state/uiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { selectedTerm } from './define/selectedTerm';
import { selectionTarget, textSlice, wordRangeAt } from './selectionTarget';

interface MenuState {
  point: ContextPoint;
  keyboard: boolean;
}

/** Slack around a line box, in CSS pixels, so a click on a descender or the
 * sliver between two letters still counts as on the word. */
const HIT_SLOP = 2;
const TERM_LABEL_MAX = 24;
const OPENABLE = /^(https?:|mailto:)/i;

/** A right click, or ⌃-click — the same gesture on a Mac. */
function isContextClick(event: MouseEvent): boolean {
  return event.button === 2 || (event.button === 0 && event.ctrlKey);
}

function within(
  rect: DOMRect | { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
) {
  return (
    x >= rect.left - HIT_SLOP &&
    x <= rect.right + HIT_SLOP &&
    y >= rect.top - HIT_SLOP &&
    y <= rect.bottom + HIT_SLOP
  );
}

/** Is the point on the painted selection? Asked of the DOM, line box by line
 * box, because a position test counts the far end of a line as "inside". */
function onSelection(editor: Editor, x: number, y: number): boolean {
  const { selection } = editor.state;
  if (selection.empty) return false;
  if (selection instanceof AllSelection) return true;
  if (selection instanceof NodeSelection) {
    const dom = editor.view.nodeDOM(selection.from);
    return dom instanceof Element && within(dom.getBoundingClientRect(), x, y);
  }
  const range = document.getSelection();
  if (!range?.rangeCount) return false;
  return [...range.getRangeAt(0).getClientRects()].some((rect) => within(rect, x, y));
}

/** The word under the pointer, only if the pointer is actually on it. */
function wordUnder(editor: Editor, pos: number, x: number, y: number) {
  const range = wordRangeAt(editor.state.doc, pos);
  if (!range) return null;
  const { view } = editor;
  const start = view.coordsAtPos(range.from, 1);
  const end = view.coordsAtPos(range.to, -1);
  // A word wrapped over two lines has no single box; take it as hit.
  if (Math.abs(start.top - end.top) > 2) return range;
  return within(
    { left: start.left, right: end.right, top: start.top, bottom: start.bottom },
    x,
    y,
  )
    ? range
    : null;
}

export function EditorContextMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const close = useCallback(() => setMenu(null), []);
  // Read by the transaction listener: the selection a context click makes
  // itself happens before the menu exists and must not close it.
  const shown = useRef(false);
  shown.current = menu !== null;

  useEffect(() => {
    const dom = editor.view.dom;
    const ignored = (event: MouseEvent) =>
      event.shiftKey ||
      (event.target instanceof Element &&
        !!event.target.closest('input, textarea, button, [contenteditable="false"]'));

    // Capture, so ProseMirror's own mousedown never sees a context click and
    // starts a drag-selection from it.
    const down = (event: MouseEvent) => {
      if (!isContextClick(event) || ignored(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const open = (event: MouseEvent) => {
      if (ignored(event)) return;
      event.preventDefault();
      const { view } = editor;
      const x = event.clientX;
      const y = event.clientY;
      if (!view.hasFocus()) view.focus();
      if (!onSelection(editor, x, y)) {
        const hit = view.posAtCoords({ left: x, top: y });
        if (hit) {
          const { doc } = editor.state;
          const word = wordUnder(editor, hit.pos, x, y);
          view.dispatch(
            editor.state.tr.setSelection(
              word
                ? TextSelection.create(doc, word.from, word.to)
                : TextSelection.near(doc.resolve(hit.pos)),
            ),
          );
        }
      }
      setMenu({ point: { x, y }, keyboard: false });
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const coords = editor.view.coordsAtPos(editor.state.selection.head);
      setMenu({ point: { x: coords.left, y: coords.bottom + 2 }, keyboard: true });
    };
    // Something else moved the text under the menu — an autosave merge, an
    // agent's edit. A beat of grace lets a chosen row finish its blink first.
    const transaction = ({ transaction: tr }: { transaction: Transaction }) => {
      if (shown.current && (tr.docChanged || tr.selectionSet)) setTimeout(close, 100);
    };
    dom.addEventListener('mousedown', down, true);
    dom.addEventListener('contextmenu', open);
    dom.addEventListener('keydown', key);
    editor.on('transaction', transaction);
    return () => {
      dom.removeEventListener('mousedown', down, true);
      dom.removeEventListener('contextmenu', open);
      dom.removeEventListener('keydown', key);
      editor.off('transaction', transaction);
    };
  }, [editor, close]);

  useEffect(() => {
    if (!menu) return;
    // Native menus go when what is under them scrolls; scrolling the menu's
    // own list is not that.
    const scroll = (event: Event) => {
      if (!(
        event.target instanceof Element &&
        event.target.closest('[data-editor-context-menu]')
      ))
        close();
    };
    window.addEventListener('scroll', scroll, true);
    return () => window.removeEventListener('scroll', scroll, true);
  }, [menu, close]);

  if (!menu) return null;
  const { state } = editor;
  const selected = !state.selection.empty;
  const editable = editor.isEditable;
  const text =
    selected && !!state.doc.textBetween(state.selection.from, state.selection.to).trim();
  const term = selectedTerm(editor).term;
  const shortTerm = !!term && term.length <= 120 && term.split(/\s+/).length <= 8;
  const termLabel =
    term.length > TERM_LABEL_MAX
      ? `${term.slice(0, TERM_LABEL_MAX - 1).trimEnd()}…`
      : term;
  const assist = selectionTarget(editor);
  const onLink = editor.isActive('link');
  const href = onLink
    ? (editor.getAttributes('link').href as string | undefined)
    : undefined;
  const notice = (key: string) => useUiStore.getState().showStatusNotice(t(key));

  const appItem = (
    id: AppCommandId,
    icon: typeof Bold,
    options: { label?: string; disabled?: boolean; title?: string } = {},
  ): ContextMenuEntry => ({
    id,
    icon,
    label: options.label || t(APP_COMMANDS[id].labelKey),
    disabled: options.disabled,
    title: options.title,
    shortcut: commandShortcut(APP_COMMANDS[id].accelerator) || undefined,
    onSelect: () => {
      editor.commands.focus();
      void runAppCommand(id);
    },
  });

  async function paste(plain: boolean) {
    editor.commands.focus();
    const { doc, selection } = editor.state;
    const origin = useEditorStore.getState().note?.id;
    try {
      let html = '';
      let value = '';
      if (!plain && navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes('text/html'))
            html = await (await item.getType('text/html')).text();
          if (item.types.includes('text/plain'))
            value = await (await item.getType('text/plain')).text();
          if (html || value) break;
        }
      } else value = await navigator.clipboard.readText();
      if (
        editor.isDestroyed ||
        !editor.isEditable ||
        origin !== useEditorStore.getState().note?.id ||
        !editor.state.doc.eq(doc) ||
        !editor.state.selection.eq(selection)
      ) {
        notice('contextMenu.clipboardChanged');
        return;
      }
      if (html && !plain) editor.view.pasteHTML(html);
      else if (value && plain)
        editor.view.dispatch(
          editor.state.tr.replaceSelection(textSlice(editor, value)).scrollIntoView(),
        );
      else if (value) editor.view.pasteText(value);
      else notice('contextMenu.clipboardEmpty');
    } catch {
      notice('contextMenu.clipboardFailed');
    }
  }

  const clipboard = (id: 'cut' | 'copy'): ContextMenuEntry => ({
    id,
    icon: id === 'cut' ? Scissors : Copy,
    label: t(id === 'cut' ? 'menu.cut' : 'menu.copy'),
    shortcut: id === 'cut' ? '⌘X' : '⌘C',
    onSelect: () => {
      editor.commands.focus();
      if (!document.execCommand(id)) notice('contextMenu.clipboardFailed');
    },
  });

  const pasteItems: ContextMenuEntry[] = editable
    ? [
        {
          id: 'paste',
          icon: ClipboardPaste,
          label: t('menu.paste'),
          shortcut: '⌘V',
          onSelect: () => void paste(false),
        },
        {
          id: 'pastePlain',
          icon: ClipboardType,
          label: t('contextMenu.pastePlain'),
          onSelect: () => void paste(true),
        },
      ]
    : [];

  const linkItems: ContextMenuEntry[] =
    onLink && href
      ? [
          {
            id: 'openLink',
            icon: ExternalLink,
            label: t('contextMenu.openLink'),
            disabled: !OPENABLE.test(href),
            onSelect: () => {
              externalLinks.open(href).catch(() => notice('error.openExternalLink'));
            },
          },
          {
            id: 'copyLink',
            icon: Copy,
            label: t('contextMenu.copyLink'),
            onSelect: () => {
              navigator.clipboard
                .writeText(href)
                .catch(() => notice('contextMenu.clipboardFailed'));
            },
          },
          ...(editable
            ? [
                appItem('insert.link', Link2, { label: t('contextMenu.editLink') }),
                {
                  id: 'removeLink',
                  icon: Link2Off,
                  label: t('contextMenu.removeLink'),
                  onSelect: () => {
                    editor.chain().focus().extendMarkRange('link').unsetLink().run();
                  },
                },
              ]
            : []),
        ]
      : [];

  // Ordered as a macOS text menu is: what you can learn about the words
  // first, then the clipboard, then what you can do to them.
  const items: ContextMenuEntry[] = selected
    ? [
        ...(editable && shortTerm
          ? [
              appItem('ai.define', BookA, {
                label: t('contextMenu.defineTerm', { term: termLabel }),
              }),
              ...(useEditorStore.getState().note?.courseId
                ? [
                    appItem('vocabulary.addWord', BookPlus, {
                      label: t('contextMenu.addTerm', { term: termLabel }),
                    }),
                  ]
                : []),
              null,
            ]
          : []),
        ...(editable ? [clipboard('cut')] : []),
        clipboard('copy'),
        ...pasteItems,
        null,
        ...linkItems,
        null,
        ...(editable && text
          ? [
              appItem('ai.correctSelection', SpellCheck2, {
                disabled: !assist,
                title: !assist ? t('contextMenu.selectionLimit') : undefined,
              }),
              appItem('ai.rewriteSelection', PenLine, {
                disabled: !assist,
                title: !assist ? t('contextMenu.selectionLimit') : undefined,
              }),
            ]
          : []),
      ]
    : [
        ...pasteItems,
        {
          id: 'selectAll',
          icon: TextSelect,
          label: t('menu.selectAll'),
          shortcut: '⌘A',
          onSelect: () => {
            editor.chain().focus().selectAll().run();
          },
        },
        null,
        ...linkItems,
        null,
        ...(editable
          ? [
              ...(onLink ? [] : [appItem('insert.link', Link2)]),
              appItem('insert.date', CalendarDays),
            ]
          : []),
      ];

  const formats = [
    { id: 'format.bold', mark: 'bold', icon: Bold },
    { id: 'format.italic', mark: 'italic', icon: Italic },
    { id: 'format.underline', mark: 'underline', icon: Underline },
    { id: 'format.highlight', mark: 'highlight', icon: Highlighter },
    { id: 'insert.link', mark: 'link', icon: Link2 },
  ] as const;
  const toolbar: ContextToolbarItem[] | undefined =
    editable && text
      ? formats.map(({ id, mark, icon }) => {
          const shortcut = commandShortcut(APP_COMMANDS[id].accelerator);
          return {
            id: `toolbar-${id}`,
            icon,
            label: `${t(APP_COMMANDS[id].labelKey)}${shortcut ? ` (${shortcut})` : ''}`,
            pressed: editor.isActive(mark),
            onSelect: () => {
              editor.commands.focus();
              void runAppCommand(id);
            },
          };
        })
      : undefined;

  return createPortal(
    <div data-editor-context-menu>
      <ContextMenu
        point={menu.point}
        items={items}
        onClose={close}
        retainFocus
        openedByKeyboard={menu.keyboard}
        toolbar={toolbar}
        footer={editable ? t('contextMenu.spellingHint') : undefined}
      />
    </div>,
    document.body,
  );
}
