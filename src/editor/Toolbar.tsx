import type { Editor } from '@tiptap/core';
import {
  Bold,
  AlignCenter,
  AlignLeft,
  AlignRight,
  CheckSquare,
  ChevronDown,
  Code2,
  Highlighter,
  Image,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareWarning,
  MoreHorizontal,
  PencilRuler,
  Quote,
  Sigma,
  Table2,
  Underline as UnderlineIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorCommand } from './commandBridge';
import { cn } from '@/lib/utils/cn';

interface ToolbarProps {
  editor: Editor;
  run(command: EditorCommand): void;
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn('nb-editor-tool', active && 'is-active')}
    >
      {children}
    </button>
  );
}

export function Toolbar({ editor, run }: ToolbarProps) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [moreOpen]);

  const extraActions = [
    {
      label: t('menu.highlight'),
      icon: Highlighter,
      action: () => run('highlight'),
      active: editor.isActive('highlight'),
    },
    {
      label: t('menu.code'),
      icon: Code2,
      action: () => run('code'),
      active: editor.isActive('code'),
    },
    {
      label: t('menu.link'),
      icon: Link2,
      action: () => run('link'),
      active: editor.isActive('link'),
    },
    {
      label: t('editor.orderedList'),
      icon: ListOrdered,
      action: () => editor.chain().focus().toggleOrderedList().run(),
      active: editor.isActive('orderedList'),
    },
    {
      label: t('editor.quote'),
      icon: Quote,
      action: () => editor.chain().focus().toggleBlockquote().run(),
      active: editor.isActive('blockquote'),
    },
    {
      label: t('menu.callout'),
      icon: MessageSquareWarning,
      action: () => run('callout'),
    },
    { label: t('menu.math'), icon: Sigma, action: () => run('math') },
    { label: t('menu.table'), icon: Table2, action: () => run('table') },
    { label: t('menu.image'), icon: Image, action: () => run('image') },
    { label: t('menu.drawing'), icon: PencilRuler, action: () => run('drawing') },
  ];

  return (
    <div ref={root} className="nb-editor-toolbar" role="toolbar" aria-label={t('editor.toolbar')}>
      <label className="nb-block-select">
        <span className="sr-only">{t('editor.blockStyle')}</span>
        <select
          aria-label={t('editor.blockStyle')}
          value={
            editor.isActive('heading', { level: 1 })
              ? 'h1'
              : editor.isActive('heading', { level: 2 })
                ? 'h2'
                : editor.isActive('heading', { level: 3 })
                  ? 'h3'
                  : 'paragraph'
          }
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'paragraph') editor.chain().focus().setParagraph().run();
            else
              editor
                .chain()
                .focus()
                .toggleHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 })
                .run();
          }}
        >
          <option value="paragraph">{t('editor.paragraph')}</option>
          <option value="h1">{t('editor.heading', { level: 1 })}</option>
          <option value="h2">{t('editor.heading', { level: 2 })}</option>
          <option value="h3">{t('editor.heading', { level: 3 })}</option>
        </select>
        <ChevronDown size={12} aria-hidden />
      </label>

      <span className="nb-toolbar-divider" />

      <ToolButton
        label={t('menu.bold')}
        active={editor.isActive('bold')}
        onClick={() => run('bold')}
      >
        <Bold size={14} />
      </ToolButton>
      <ToolButton
        label={t('menu.italic')}
        active={editor.isActive('italic')}
        onClick={() => run('italic')}
      >
        <Italic size={14} />
      </ToolButton>
      <ToolButton
        label={t('menu.underline')}
        active={editor.isActive('underline')}
        onClick={() => run('underline')}
      >
        <UnderlineIcon size={14} />
      </ToolButton>

      <span className="nb-toolbar-divider" />

      <ToolButton
        label={t('editor.bulletList')}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={14} />
      </ToolButton>
      <ToolButton
        label={t('editor.taskList')}
        active={editor.isActive('taskList')}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      >
        <CheckSquare size={14} />
      </ToolButton>

      <span className="nb-toolbar-divider" />

      <ToolButton
        label={t('editor.moreFormatting')}
        active={moreOpen}
        onClick={() => setMoreOpen((open) => !open)}
      >
        <MoreHorizontal size={15} />
      </ToolButton>

      {moreOpen && (
        <div className="nb-format-menu">
          {extraActions.map(({ label, icon: Icon, action, active }) => (
            <button
              type="button"
              key={label}
              aria-pressed={active || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                action();
                setMoreOpen(false);
              }}
            >
              <Icon size={14} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}

      {editor.isActive('table') && (
        <div className="nb-table-actions">
          <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()}>
            {t('editor.addRow')}
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          >
            {t('editor.addColumn')}
          </button>
          <button type="button" onClick={() => editor.chain().focus().deleteRow().run()}>
            {t('editor.deleteRow')}
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().deleteColumn().run()}
          >
            {t('editor.deleteColumn')}
          </button>
          <span />
          {[
            { value: 'left', label: t('editor.alignLeft'), Icon: AlignLeft },
            { value: 'center', label: t('editor.alignCenter'), Icon: AlignCenter },
            { value: 'right', label: t('editor.alignRight'), Icon: AlignRight },
          ].map(({ value, label, Icon }) => (
            <button
              type="button"
              key={value}
              aria-label={label}
              title={label}
              onClick={() => {
                const type = editor.isActive('tableHeader') ? 'tableHeader' : 'tableCell';
                editor.chain().focus().updateAttributes(type, { textAlign: value }).run();
              }}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
