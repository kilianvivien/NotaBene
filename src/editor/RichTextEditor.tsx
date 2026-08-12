import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useTranslation } from 'react-i18next';
import type { NoteDoc } from '@/lib/schema';
import { storeAssetCommand } from '@/lib/commands';
import { createNoteCommand } from '@/lib/commands';
import { useEditorStore } from '@/lib/state/editorStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { editorExtensions } from './extensions';
import {
  concentrationPluginKey,
  type ConcentrationState,
} from './extensions/Concentration';
import { registerEditorCommandRunner, type EditorCommand } from './commandBridge';
import { registerEditorPrompt, type EditorPromptRequest } from './editorPrompt';
import { EditorPromptDialog } from './EditorPromptDialog';
import { TableControls } from './TableControls';
import { Toolbar } from './Toolbar';
import { SlashMenu, type SlashState } from './SlashMenu';
import { WikiLinkMenu, type WikiLinkState } from './WikiLinkMenu';
import { FindReplaceBar } from './FindReplaceBar';
import { markdownToDoc } from './markdown';
import './editor.css';

interface RichTextEditorProps {
  doc: NoteDoc;
  editable?: boolean;
  onChange(doc: NoteDoc): void;
}

function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)(#{1,6}\s|[-*+]\s|>\s|```|\$\$\s*$|\d+[.)]\s|\|.+\|)/m.test(text);
}

export function RichTextEditor({ doc, editable = true, onChange }: RichTextEditorProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [wikiLink, setWikiLink] = useState<WikiLinkState | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [prompt, setPrompt] = useState<EditorPromptRequest | null>(null);
  const resolvePromptRef = useRef<((value: string | null) => void) | null>(null);
  const [, refresh] = useState(0);
  // Read through the store rather than subscribing: editing either in Settings
  // must not remount the editor the user is typing in.
  const resolveAbbreviations = useCallback(
    () => useSettingsStore.getState().settings.abbreviations,
    [],
  );
  const resolveConcentration = useCallback((): ConcentrationState => {
    const { focus } = useSettingsStore.getState().settings;
    return {
      active: useUiStore.getState().focusMode,
      lineFocus: focus.lineFocus,
      blockCaret: focus.appearance === 'typewriter',
      typewriterScrolling: focus.typewriterScrolling,
    };
  }, []);
  const extensions = useMemo(
    () =>
      editorExtensions(
        t('editor.bodyPlaceholder'),
        resolveAbbreviations,
        resolveConcentration,
      ),
    [resolveAbbreviations, resolveConcentration, t],
  );

  const insertImages = useCallback(async (files: File[]) => {
    const editor = editorRef.current;
    if (!editor) return;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const stored = await storeAssetCommand(file);
      if (!stored.ok) continue;
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'image',
          attrs: {
            assetId: stored.value.id,
            alt: file.name,
            caption: '',
            align: 'center',
            width: 640,
          },
        })
        .run();
    }
  }, []);

  /**
   * The resolver is a ref and both callbacks are stable on purpose. This
   * component re-renders on every ProseMirror transaction, and `ModalOverlay`
   * re-runs its focus trap whenever `onClose` changes identity — a fresh
   * closure here made focus-restore and transaction chase each other until
   * React gave up on the update depth.
   */
  const ask = useCallback(
    (request: EditorPromptRequest) =>
      new Promise<string | null>((resolve) => {
        // One prompt at a time: whatever was already open is dismissed rather
        // than left with a promise nobody will ever settle.
        resolvePromptRef.current?.(null);
        resolvePromptRef.current = resolve;
        setPrompt(request);
      }),
    [],
  );

  const resolvePrompt = useCallback((value: string | null) => {
    const resolve = resolvePromptRef.current;
    resolvePromptRef.current = null;
    setPrompt(null);
    resolve?.(value);
  }, []);

  useEffect(() => registerEditorPrompt(ask), [ask]);

  const editor = useEditor({
    extensions,
    content: doc,
    editable,
    editorProps: {
      attributes: {
        class: 'nb-prosemirror',
        'aria-label': t('editor.bodyPlaceholder'),
      },
      handlePaste(_view, event) {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;
        const imageFiles = [...clipboard.files].filter((file) =>
          file.type.startsWith('image/'),
        );
        if (imageFiles.length) {
          event.preventDefault();
          void insertImages(imageFiles);
          return true;
        }
        if (clipboard.getData('text/html')) return false;
        const text = clipboard.getData('text/plain');
        if (!looksLikeMarkdown(text)) return false;
        event.preventDefault();
        editorRef.current?.commands.insertContent(markdownToDoc(text).content);
        return true;
      },
      handleDrop(_view, event) {
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return false;
        const imageFiles = [...dataTransfer.files].filter((file) =>
          file.type.startsWith('image/'),
        );
        if (!imageFiles.length) return false;
        event.preventDefault();
        void insertImages(imageFiles);
        return true;
      },
      handleClick(view, position, event) {
        const element =
          event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>('a[data-wiki-link]')
            : null;
        if (!element) return false;
        event.preventDefault();
        const noteId = element.getAttribute('data-note-id');
        const title = element.getAttribute('data-title') ?? element.textContent ?? '';
        void (async () => {
          let targetId = noteId;
          if (!targetId) {
            if (!view.editable) return;
            const created = await createNoteCommand({ title });
            if (!created.ok) return;
            targetId = created.value.id;
            const node = view.state.doc.nodeAt(position);
            if (node?.type.name === 'wikiLink') {
              view.dispatch(
                view.state.tr.setNodeMarkup(position, undefined, {
                  ...node.attrs,
                  noteId: targetId,
                }),
              );
            }
          }
          useUiStore.getState().selectNote(targetId);
          await useEditorStore.getState().openNote(targetId);
        })();
        return true;
      },
    },
    onUpdate({ editor: current }) {
      onChange(current.getJSON() as NoteDoc);
    },
    onTransaction() {
      refresh((value) => value + 1);
    },
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    const current = JSON.stringify(editor.getJSON());
    const incoming = JSON.stringify(doc);
    if (current !== incoming) editor.commands.setContent(doc, { emitUpdate: false });
  }, [doc, editor]);

  /**
   * Concentration decorations are derived from the selection, so they only get
   * recomputed when a transaction lands. Toggling line focus in Settings while
   * the editor sits idle is a change with no transaction behind it — this is
   * the nudge. History-free, because redecorating is not an edit.
   */
  useEffect(() => {
    if (!editor) return;
    const nudge = () => {
      if (editor.isDestroyed) return;
      editor.view.dispatch(
        editor.view.state.tr
          .setMeta(concentrationPluginKey, 'refresh')
          .setMeta('addToHistory', false),
      );
    };
    const stopSettings = useSettingsStore.subscribe((state, previous) =>
      state.settings.focus === previous.settings.focus ? undefined : nudge(),
    );
    const stopUi = useUiStore.subscribe((state, previous) =>
      state.focusMode === previous.focusMode ? undefined : nudge(),
    );
    return () => {
      stopSettings();
      stopUi();
    };
  }, [editor]);

  const run = useCallback(
    async (command: EditorCommand): Promise<boolean> => {
      const current = editorRef.current;
      if (!current) return false;

      switch (command) {
        case 'bold':
          return current.chain().focus().toggleBold().run();
        case 'italic':
          return current.chain().focus().toggleItalic().run();
        case 'underline':
          return current.chain().focus().toggleUnderline().run();
        case 'highlight':
          return current
            .chain()
            .focus()
            .toggleHighlight({ color: 'var(--nb-mark)' })
            .run();
        case 'code':
          return current.chain().focus().toggleCode().run();
        case 'image':
          inputRef.current?.click();
          return true;
        case 'drawing':
          return current
            .chain()
            .focus()
            .insertContent({ type: 'drawing', attrs: { title: t('editor.drawing') } })
            .run();
        case 'table':
          return current
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run();
        case 'callout':
          return current
            .chain()
            .focus()
            .insertContent({
              type: 'callout',
              attrs: { kind: 'info' },
              content: [{ type: 'paragraph' }],
            })
            .run();
        case 'math': {
          const latex = await ask({
            title: t('editor.mathPrompt'),
            value: '',
            math: true,
          });
          if (latex === null || !latex.trim()) return false;
          return current
            .chain()
            .focus()
            .insertContent({ type: 'mathBlock', attrs: { latex } })
            .run();
        }
        case 'link': {
          const previous = current.getAttributes('link').href as string | undefined;
          const href = await ask({
            title: t('editor.linkPrompt'),
            value: previous ?? 'https://',
            placeholder: 'https://',
          });
          if (href === null) return false;
          if (!href)
            return current.chain().focus().extendMarkRange('link').unsetLink().run();
          return current.chain().focus().extendMarkRange('link').setLink({ href }).run();
        }
        case 'find':
          setFindOpen(true);
          return true;
      }
    },
    [ask, t],
  );

  useEffect(() => registerEditorCommandRunner(run), [run]);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const { $from } = editor.state.selection;
      if (!$from.parent.isTextblock) {
        setSlash(null);
        setWikiLink(null);
        return;
      }
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
      const match = before.match(/(?:^|\s)\/([^\s/]*)$/);
      const wikiMatch = before.match(/(?:^|\s)\[\[([^\]\n]*)$/);
      if (wikiMatch) {
        const query = wikiMatch[1] ?? '';
        const from = editor.state.selection.from - query.length - 2;
        const coords = editor.view.coordsAtPos(editor.state.selection.from);
        setWikiLink({
          query,
          from,
          to: editor.state.selection.from,
          x: coords.left,
          y: coords.bottom + 6,
        });
        setSlash(null);
        return;
      }
      setWikiLink(null);
      if (!match) {
        setSlash(null);
        return;
      }
      const query = match[1] ?? '';
      const from = editor.state.selection.from - query.length - 1;
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      setSlash({
        query,
        from,
        to: editor.state.selection.from,
        x: coords.left,
        y: coords.bottom + 6,
      });
    };
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="nb-rich-editor">
      {/* One sticky row, not two stacked strips. The find bar used to be its
          own sticky element above the toolbar, which put a floating panel
          between the note title and the formatting controls and pushed the
          body down whenever it opened. */}
      {editable && (
        <div className="nb-editor-bar">
          <Toolbar editor={editor} run={(command) => void run(command)} />
          <FindReplaceBar
            editor={editor}
            open={findOpen}
            onClose={() => setFindOpen(false)}
          />
        </div>
      )}
      <EditorContent editor={editor} />
      {editable && <TableControls editor={editor} />}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          void insertImages([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      {slash && (
        <SlashMenu
          editor={editor}
          state={slash}
          close={() => setSlash(null)}
          run={(command) => void run(command)}
        />
      )}
      {wikiLink && (
        <WikiLinkMenu
          editor={editor}
          state={wikiLink}
          currentNoteId={useEditorStore.getState().note?.id ?? null}
          close={() => setWikiLink(null)}
        />
      )}
      <EditorPromptDialog request={prompt} onResolve={resolvePrompt} />
    </div>
  );
}
