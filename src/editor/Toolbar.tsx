import type { Editor } from '@tiptap/core';
import {
  Bold,
  CheckSquare,
  ChevronDown,
  Code2,
  Highlighter,
  Image,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  MessageSquareWarning,
  MoreHorizontal,
  PencilRuler,
  Play,
  Quote,
  Sigma,
  Square,
  Table2,
  Underline as UnderlineIcon,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorCommand } from './commandBridge';
import { useSpeechStore } from '@/lib/state/speechStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { cn } from '@/lib/utils/cn';

interface ToolbarProps {
  editor: Editor;
  run(command: EditorCommand): void;
}

function ToolButton({
  label,
  active,
  compactHide,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  compactHide?: boolean;
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
      className={cn(
        'nb-editor-tool',
        compactHide && 'nb-toolbar-compact-hide',
        active && 'is-active',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Read this note aloud.
 *
 * Deliberately not behind the AI panel: no provider writes a script, nothing
 * leaves the machine, and the thing spoken is the note as written. It reads the
 * selection when there is one, which is how you check a paragraph you have just
 * rewritten without listening to the twelve before it.
 */
function ReadAloudButton({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const speech = useSettingsStore((state) => state.settings.speech);
  const status = useSpeechStore((state) => state.status);
  const phase = useSpeechStore((state) => state.phase);
  const done = useSpeechStore((state) => state.done);
  const total = useSpeechStore((state) => state.total);
  const error = useSpeechStore((state) => state.error);
  const speak = useSpeechStore((state) => state.speak);
  const stop = useSpeechStore((state) => state.stop);
  const toggle = useSpeechStore((state) => state.toggle);
  const voiceId = speech.voicesByEngine[speech.engineId] ?? '';

  const idle = status === 'idle';
  const label = idle
    ? t('editor.readAloud')
    : status === 'paused'
      ? t('editor.resumeReading')
      : t('editor.stopReading');

  return (
    <>
      <ToolButton
        label={label}
        active={!idle}
        onClick={() => {
          if (status === 'paused') return toggle();
          if (!idle) return stop();
          const { from, to } = editor.state.selection;
          const text =
            from === to
              ? editor.state.doc.textBetween(
                  0,
                  editor.state.doc.content.size,
                  '\n\n',
                  ' ',
                )
              : editor.state.doc.textBetween(from, to, '\n\n', ' ');
          void speak(text, voiceId);
        }}
      >
        {status === 'preparing' ? (
          <Loader2 size={14} className="animate-spin" />
        ) : status === 'playing' ? (
          <Square size={13} />
        ) : status === 'paused' ? (
          <Play size={14} />
        ) : (
          <Volume2 size={14} />
        )}
      </ToolButton>
      {status === 'preparing' && phase && (
        <span className="nb-speech-status text-nb-text-3" aria-live="polite">
          {t(`editor.speech_${phase}`)}
        </span>
      )}
      {!idle && total > 0 && (
        <span className="nb-tool-text tabular-nums text-nb-text-3" aria-live="polite">
          {done}/{total}
        </span>
      )}
      {idle && error && (
        // Visible, not just announced: a failed reading otherwise looks
        // identical to a reading that never started, and the user is left
        // pressing a button that appears to do nothing.
        <span
          className="nb-tool-text max-w-[22ch] truncate text-[var(--nb-danger)]"
          role="alert"
          title={error}
        >
          {error}
        </span>
      )}
    </>
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
      label: t('editor.bulletList'),
      icon: List,
      action: () => editor.chain().focus().toggleBulletList().run(),
      active: editor.isActive('bulletList'),
    },
    {
      label: t('editor.taskList'),
      icon: CheckSquare,
      action: () => editor.chain().focus().toggleTaskList().run(),
      active: editor.isActive('taskList'),
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
    <div
      ref={root}
      className="nb-editor-toolbar"
      role="toolbar"
      aria-label={t('editor.toolbar')}
    >
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
      <ToolButton
        label={t('menu.highlight')}
        active={editor.isActive('highlight')}
        onClick={() => run('highlight')}
      >
        <Highlighter size={14} />
      </ToolButton>

      <span className="nb-toolbar-divider nb-toolbar-compact-hide" />

      <ToolButton
        label={t('editor.bulletList')}
        active={editor.isActive('bulletList')}
        compactHide
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={14} />
      </ToolButton>
      <ToolButton
        label={t('editor.taskList')}
        active={editor.isActive('taskList')}
        compactHide
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      >
        <CheckSquare size={14} />
      </ToolButton>

      <span className="nb-toolbar-divider nb-toolbar-compact-hide" />

      <ToolButton
        label={t('editor.moreFormatting')}
        active={moreOpen}
        onClick={() => setMoreOpen((open) => !open)}
      >
        <MoreHorizontal size={15} />
      </ToolButton>

      <span className="nb-toolbar-divider" />

      <ReadAloudButton editor={editor} />

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

      {/* Table controls are not here: they live in `TableControls`, pinned to
          the table itself, because a control that acts on a cell belongs
          beside that cell and not in a strip across the top of the note. */}
    </div>
  );
}
