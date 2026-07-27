/**
 * Table controls, attached to the table.
 *
 * These used to live in the formatting toolbar as a full-width strip of text
 * buttons — "Add row  Add column  Delete row  Delete column" — that appeared
 * under the toolbar whenever the cursor entered a table, pushed the note body
 * down, and sat several hundred pixels from the cells it acted on. In French
 * the same four labels were wide enough to overlap the note.
 *
 * So it is a small floating bar pinned to the top-left corner of the table the
 * cursor is actually in. The controls are icons in three groups — rows,
 * columns, alignment — which is enough to fit them beside the table rather
 * than across the page, and which puts "delete column" next to the column it
 * will delete.
 *
 * Positioned in viewport coordinates from the table's own bounding box rather
 * than by CSS, because the anchor is a node inside a scrolling editor and there
 * is no element to hang `position: absolute` off without wrapping every table
 * in a container ProseMirror does not want.
 */
import type { Editor } from '@tiptap/core';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Columns3,
  Minus,
  Plus,
  Rows3,
  Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Anchor {
  top: number;
  left: number;
}

/** The DOM element of the table the selection is inside, or null. */
function activeTable(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') {
      const dom = editor.view.nodeDOM($from.before(depth));
      return dom instanceof HTMLElement ? dom : null;
    }
  }
  return null;
}

function same(a: Anchor | null, b: Anchor | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return Math.round(a.top) === Math.round(b.top) && Math.round(a.left) === Math.round(b.left);
}

export function TableControls({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const inTable = editor.isActive('table');

  /**
   * Re-measure after every render, because `RichTextEditor` re-renders on every
   * transaction and there is no dependency that captures "the table moved".
   *
   * Hence the identity check: this effect deliberately has no dependency array,
   * so returning a fresh object unconditionally would set state on every render
   * and re-render forever. Returning `current` when nothing moved makes React
   * bail out, which is what stops the loop.
   */
  const measure = () => {
    const table = inTable ? activeTable(editor) : null;
    const next: Anchor | null = table
      ? { top: table.getBoundingClientRect().top, left: table.getBoundingClientRect().left }
      : null;
    setAnchor((current) => (same(current, next) ? current : next));
  };

  // Before paint, so the bar never shows for a frame at the previous table's
  // position when the cursor moves between two of them.
  useLayoutEffect(measure);

  // The anchor is a viewport coordinate, so it is wrong the moment anything
  // scrolls. `capture` catches the editor's own scroll container, which does
  // not bubble.
  useEffect(() => {
    if (!inTable) return;
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
    // `measure` closes over this render's `inTable`; rebinding it on every
    // render would add and remove two listeners per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, inTable]);

  if (!anchor) return null;

  const align = (value: 'left' | 'center' | 'right') => {
    const type = editor.isActive('tableHeader') ? 'tableHeader' : 'tableCell';
    editor.chain().focus().updateAttributes(type, { textAlign: value }).run();
  };

  return (
    <div
      className="nb-table-controls"
      role="toolbar"
      aria-label={t('editor.tableControls')}
      // Held above the table with a fixed offset; `translateY(-100%)` would
      // depend on the bar's own height, which changes with the locale.
      style={{ top: anchor.top - 38, left: anchor.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="nb-table-group">
        <Rows3 size={13} aria-hidden />
        <button
          type="button"
          title={t('editor.addRow')}
          aria-label={t('editor.addRow')}
          onClick={() => editor.chain().focus().addRowAfter().run()}
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          title={t('editor.deleteRow')}
          aria-label={t('editor.deleteRow')}
          onClick={() => editor.chain().focus().deleteRow().run()}
        >
          <Minus size={12} />
        </button>
      </span>

      <span className="nb-table-group">
        <Columns3 size={13} aria-hidden />
        <button
          type="button"
          title={t('editor.addColumn')}
          aria-label={t('editor.addColumn')}
          onClick={() => editor.chain().focus().addColumnAfter().run()}
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          title={t('editor.deleteColumn')}
          aria-label={t('editor.deleteColumn')}
          onClick={() => editor.chain().focus().deleteColumn().run()}
        >
          <Minus size={12} />
        </button>
      </span>

      <span className="nb-table-group">
        {(
          [
            ['left', t('editor.alignLeft'), AlignLeft],
            ['center', t('editor.alignCenter'), AlignCenter],
            ['right', t('editor.alignRight'), AlignRight],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => align(value)}
          >
            <Icon size={12} />
          </button>
        ))}
      </span>

      <button
        type="button"
        className="nb-table-delete"
        title={t('editor.deleteTable')}
        aria-label={t('editor.deleteTable')}
        onClick={() => editor.chain().focus().deleteTable().run()}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}
