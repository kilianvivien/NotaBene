import type { Editor } from '@tiptap/core';
import {
  Heading2,
  Image,
  List,
  ListChecks,
  MessageSquareWarning,
  PanelTop,
  PencilRuler,
  Pilcrow,
  Sigma,
  Table2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorCommand } from './commandBridge';

export interface SlashState {
  query: string;
  from: number;
  to: number;
  x: number;
  y: number;
}

interface SlashMenuProps {
  editor: Editor;
  state: SlashState;
  close(): void;
  run(command: EditorCommand): void;
}

export function SlashMenu({ editor, state, close, run }: SlashMenuProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const items = useMemo(
    () =>
      [
        {
          id: 'paragraph',
          label: t('editor.paragraph'),
          icon: Pilcrow,
          action: () => editor.chain().focus().setParagraph().run(),
        },
        {
          id: 'heading',
          label: t('editor.heading', { level: 2 }),
          icon: Heading2,
          action: () => editor.chain().focus().setHeading({ level: 2 }).run(),
        },
        {
          id: 'bullet',
          label: t('editor.bulletList'),
          icon: List,
          action: () => editor.chain().focus().toggleBulletList().run(),
        },
        {
          id: 'tasks',
          label: t('editor.taskList'),
          icon: ListChecks,
          action: () => editor.chain().focus().toggleTaskList().run(),
        },
        {
          id: 'callout',
          label: t('menu.callout'),
          icon: MessageSquareWarning,
          action: () => run('callout'),
        },
        {
          id: 'toggle',
          label: t('editor.toggle'),
          icon: PanelTop,
          action: () =>
            editor
              .chain()
              .focus()
              .insertContent({
                type: 'toggle',
                attrs: { summary: t('editor.toggleSummary') },
                content: [{ type: 'paragraph' }],
              })
              .run(),
        },
        {
          id: 'math',
          label: t('menu.math'),
          icon: Sigma,
          action: () => run('math'),
        },
        {
          id: 'table',
          label: t('menu.table'),
          icon: Table2,
          action: () => run('table'),
        },
        {
          id: 'image',
          label: t('menu.image'),
          icon: Image,
          action: () => run('image'),
        },
        {
          id: 'drawing',
          label: t('menu.drawing'),
          icon: PencilRuler,
          action: () => run('drawing'),
        },
      ].filter((item) => item.label.toLowerCase().includes(state.query.toLowerCase())),
    [editor, run, state.query, t],
  );

  function choose(index: number) {
    const item = items[index];
    if (!item) return;
    editor.chain().focus().deleteRange({ from: state.from, to: state.to }).run();
    item.action();
    close();
  }

  useEffect(() => {
    setActive(0);
  }, [state.query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((current) => (current + 1) % Math.max(items.length, 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(
          (current) => (current - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1),
        );
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(active);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  return (
    <div
      className="nb-slash-menu"
      style={{ left: state.x, top: state.y }}
      role="listbox"
      aria-label={t('editor.slashMenu')}
    >
      {items.length ? (
        items.map((item, index) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              role="option"
              aria-label={item.label}
              aria-selected={active === index}
              key={item.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span className="nb-slash-icon">
                <Icon size={15} />
              </span>
              {item.label}
            </button>
          );
        })
      ) : (
        <p>{t('editor.noBlocks')}</p>
      )}
    </div>
  );
}
