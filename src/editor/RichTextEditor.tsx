import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useTranslation } from 'react-i18next';
import type { NoteDoc } from '@/lib/schema';
import { storeAssetCommand } from '@/lib/commands';
import { createNoteCommand } from '@/lib/commands';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { editorExtensions } from './extensions';
import { registerEditorCommandRunner, type EditorCommand } from './commandBridge';
import { TableControls } from './TableControls';
import { Toolbar } from './Toolbar';
import { SlashMenu, type SlashState } from './SlashMenu';
import { WikiLinkMenu, type WikiLinkState } from './WikiLinkMenu';
import { FindReplaceBar } from './FindReplaceBar';
import { markdownToDoc } from './markdown';
import './editor.css';

interface RichTextEditorProps {
  doc: NoteDoc;
  onChange(doc: NoteDoc): void;
}

function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)(#{1,6}\s|[-*+]\s|>\s|```|\$\$\s*$|\d+[.)]\s|\|.+\|)/m.test(text);
}

export function RichTextEditor({ doc, onChange }: RichTextEditorProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [wikiLink, setWikiLink] = useState<WikiLinkState | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [, refresh] = useState(0);
  useUiStore((state) => state.focusMode);
  const extensions = useMemo(() => editorExtensions(t('editor.bodyPlaceholder')), [t]);

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

  const editor = useEditor({
    extensions,
    content: doc,
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
    onSelectionUpdate({ editor: current }) {
      if (!useUiStore.getState().focusMode) return;
      requestAnimationFrame(() => {
        const { node } = current.view.domAtPos(current.state.selection.from);
        const element = node instanceof HTMLElement ? node : node.parentElement;
        element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    const current = JSON.stringify(editor.getJSON());
    const incoming = JSON.stringify(doc);
    if (current !== incoming) editor.commands.setContent(doc, { emitUpdate: false });
  }, [doc, editor]);

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
          const latex = window.prompt(t('editor.mathPrompt'), '');
          if (latex === null) return false;
          return current
            .chain()
            .focus()
            .insertContent({ type: 'mathBlock', attrs: { latex } })
            .run();
        }
        case 'link': {
          const previous = current.getAttributes('link').href as string | undefined;
          const href = window.prompt(t('editor.linkPrompt'), previous ?? 'https://');
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
    [t],
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
      <div className="nb-editor-bar">
        <Toolbar editor={editor} run={(command) => void run(command)} />
        <FindReplaceBar
          editor={editor}
          open={findOpen}
          onClose={() => setFindOpen(false)}
        />
      </div>
      <EditorContent editor={editor} />
      <TableControls editor={editor} />
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
    </div>
  );
}
