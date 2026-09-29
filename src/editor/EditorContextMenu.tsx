import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { useTranslation } from 'react-i18next';
import {
  Bold,
  Italic,
  Underline,
  Highlighter,
  Link2,
  Undo2,
  Redo2,
  Scissors,
  Copy,
  ClipboardPaste,
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
} from '@/components/glass';
import {
  APP_COMMANDS,
  runAppCommand,
  type AppCommandId,
} from '@/lib/commands/appCommands';
import { commandShortcut } from '@/app/shell/useCommandSearch';
import { useUiStore } from '@/lib/state/uiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { selectedTerm } from './define/selectedTerm';
import { selectionTarget, textSlice } from './selectionTarget';

export function EditorContextMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const [point, setPoint] = useState<ContextPoint | null>(null);
  const noteId = useEditorStore((state) => state.note?.id);
  const close = useCallback(() => setPoint(null), []);

  useEffect(() => {
    const dom = editor.view.dom;
    const open = (event: MouseEvent) => {
      // The native spelling/services menu remains available deliberately.
      if (
        event.shiftKey ||
        (event.target instanceof Element &&
          event.target.closest('input, textarea, button, [contenteditable="false"]'))
      )
        return;
      event.preventDefault();
      const pos = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      const { from, to } = editor.state.selection;
      if (pos && (pos.pos < from || pos.pos > to || from === to)) {
        editor.view.dispatch(
          editor.state.tr.setSelection(
            TextSelection.near(editor.state.doc.resolve(pos.pos)),
          ),
        );
      }
      setPoint({ x: event.clientX, y: event.clientY });
    };
    const preserve = (event: MouseEvent) => {
      if (event.button !== 2 || event.shiftKey) return;
      const pos = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      const { from, to } = editor.state.selection;
      if (pos && from !== to && pos.pos >= from && pos.pos <= to) event.preventDefault();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      setPoint({ x: coords.left, y: coords.bottom });
    };
    const transaction = ({ transaction: tr }: { transaction: Transaction }) => {
      if (tr.docChanged || tr.selectionSet) close();
    };
    dom.addEventListener('contextmenu', open);
    dom.addEventListener('mousedown', preserve);
    dom.addEventListener('keydown', key);
    editor.on('transaction', transaction);
    return () => {
      dom.removeEventListener('contextmenu', open);
      dom.removeEventListener('mousedown', preserve);
      dom.removeEventListener('keydown', key);
      editor.off('transaction', transaction);
    };
  }, [editor, close, noteId]);

  useEffect(() => {
    if (!point) return;
    const scroll = (event: Event) => {
      if (!(
        event.target instanceof Element &&
        event.target.closest('[data-editor-context-menu]')
      ))
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        editor.commands.focus();
        close();
      }
    };
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('keydown', key);
    };
  }, [point, close, editor]);

  if (!point) return null;
  const selected = !editor.state.selection.empty;
  const editable = editor.isEditable;
  const text =
    selected &&
    !!editor.state.doc
      .textBetween(editor.state.selection.from, editor.state.selection.to)
      .trim();
  const term = selectedTerm(editor).term;
  const shortTerm = !!term && term.length <= 120 && term.split(/\s+/).length <= 8;
  const assist = selectionTarget(editor);
  const notice = (key: string) => useUiStore.getState().showStatusNotice(t(key));

  const appItem = (
    id: AppCommandId,
    icon: typeof Bold,
    label?: string,
    disabled = false,
    title?: string,
  ): ContextMenuEntry => ({
    id,
    icon,
    label: label || t(APP_COMMANDS[id].labelKey),
    disabled,
    title,
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

  const items: ContextMenuEntry[] = [
    ...(editable
      ? [
          {
            id: 'undo',
            icon: Undo2,
            label: t('menu.undo'),
            shortcut: '⌘Z',
            disabled: !editor.can().undo(),
            onSelect: () => {
              editor.chain().focus().undo().run();
            },
          },
          {
            id: 'redo',
            icon: Redo2,
            label: t('menu.redo'),
            shortcut: '⇧⌘Z',
            disabled: !editor.can().redo(),
            onSelect: () => {
              editor.chain().focus().redo().run();
            },
          },
          null,
          {
            id: 'cut',
            icon: Scissors,
            label: t('menu.cut'),
            shortcut: '⌘X',
            disabled: !selected,
            onSelect: () => {
              editor.commands.focus();
              if (!document.execCommand('cut')) notice('contextMenu.clipboardFailed');
            },
          },
        ]
      : []),
    {
      id: 'copy',
      icon: Copy,
      label: t('menu.copy'),
      shortcut: '⌘C',
      disabled: !selected,
      onSelect: () => {
        editor.commands.focus();
        if (!document.execCommand('copy')) notice('contextMenu.clipboardFailed');
      },
    },
    ...(editable
      ? [
          {
            id: 'paste',
            icon: ClipboardPaste,
            label: t('menu.paste'),
            shortcut: '⌘V',
            onSelect: () => {
              void paste(false);
            },
          },
          {
            id: 'pastePlain',
            icon: ClipboardPaste,
            label: t('contextMenu.pastePlain'),
            onSelect: () => {
              void paste(true);
            },
          },
        ]
      : []),
    {
      id: 'selectAll',
      icon: TextSelect,
      label: t('menu.selectAll'),
      shortcut: '⌘A',
      onSelect: () => {
        editor.chain().focus().selectAll().run();
      },
    },
    ...(editable && text
      ? [
          null,
          appItem(
            'ai.correctSelection',
            SpellCheck2,
            undefined,
            !assist,
            !assist ? t('contextMenu.selectionLimit') : undefined,
          ),
          appItem(
            'ai.rewriteSelection',
            PenLine,
            undefined,
            !assist,
            !assist ? t('contextMenu.selectionLimit') : undefined,
          ),
        ]
      : []),
    ...(editable && shortTerm
      ? [
          null,
          appItem('ai.define', BookA),
          ...(useEditorStore.getState().note?.courseId
            ? [appItem('vocabulary.addWord', BookPlus)]
            : []),
        ]
      : []),
    ...(editable && !selected
      ? [null, appItem('insert.link', Link2), appItem('insert.date', CalendarDays)]
      : []),
  ];
  const formats = [
    { id: 'format.bold', mark: 'bold', icon: Bold },
    { id: 'format.italic', mark: 'italic', icon: Italic },
    { id: 'format.underline', mark: 'underline', icon: Underline },
    { id: 'format.highlight', mark: 'highlight', icon: Highlighter },
    { id: 'insert.link', mark: 'link', icon: Link2 },
  ] as const;

  return createPortal(
    <div data-editor-context-menu>
      <ContextMenu
        point={point}
        items={items}
        onClose={close}
        keyboard
        header={t(selected ? 'contextMenu.selection' : 'contextMenu.editing')}
        toolbar={
          editable && text ? (
            <div
              role="group"
              aria-label={t('editor.toolbar')}
              className="mb-1 flex gap-1 border-b border-[var(--nb-divider)] pb-1.5"
            >
              {formats.map(({ id, mark, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-label={t(APP_COMMANDS[id].labelKey)}
                  title={`${t(APP_COMMANDS[id].labelKey)} ${commandShortcut(APP_COMMANDS[id].accelerator) || ''}`}
                  aria-pressed={editor.isActive(mark)}
                  className="grid h-8 flex-1 place-items-center rounded-nb-xs text-nb-text-2 hover:bg-[var(--nb-hover)] aria-pressed:bg-[var(--nb-accent-soft)] aria-pressed:text-[var(--nb-accent)] focus-visible:outline-2 focus-visible:outline-[var(--nb-accent)]"
                  onClick={() => {
                    close();
                    editor.commands.focus();
                    void runAppCommand(id);
                  }}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
          ) : undefined
        }
      />
    </div>,
    document.body,
  );
}
