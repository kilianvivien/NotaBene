/**
 * A right-click menu.
 *
 * One implementation for the note list and for every row in the sidebar, so a
 * course and a note answer a secondary click the same way — with the same
 * geometry, the same dismissal rules, and the same keyboard behaviour. The
 * alternative, a bespoke popup per row type, is how two of them end up
 * disagreeing about whether Escape closes them.
 *
 * Dismissal listens on `pointerdown` rather than `click`: a menu that survives
 * until mouse-up is a menu you can accidentally activate an item in by
 * releasing over it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export interface ContextPoint {
  x: number;
  y: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  /** Optional persisted color, used for tag entries without sacrificing text contrast. */
  swatch?: string;
  onSelect(): void;
}

/** A `null` entry draws a separator, so a caller can build the list with
 * conditionals without filtering the gaps out afterwards. */
export type ContextMenuEntry = ContextMenuItem | null;

const MARGIN = 8;

export function ContextMenu({
  point,
  items,
  onClose,
  header,
}: {
  point: ContextPoint;
  items: ContextMenuEntry[];
  onClose(): void;
  /** Optional label above the items — which course you right-clicked. */
  header?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ContextPoint>(point);

  useEffect(() => {
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') onClose();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // Flip rather than clamp: a menu opened near the bottom edge should grow
  // upwards from the pointer, not slide up the screen away from it.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const x =
      point.x + width + MARGIN > window.innerWidth
        ? Math.max(MARGIN, point.x - width)
        : point.x;
    const y =
      point.y + height + MARGIN > window.innerHeight
        ? Math.max(MARGIN, point.y - height)
        : point.y;
    setPosition({ x, y });
  }, [point.x, point.y]);

  const visible = items.filter(
    (entry, index) =>
      // Drop separators that would land first, last, or beside another.
      entry !== null ||
      (index > 0 && items[index - 1] !== null && hasLater(items, index)),
  );

  return (
    <div
      ref={panel}
      role="menu"
      className={cn(
        'fixed z-[70] max-h-[min(70vh,520px)] min-w-[188px] max-w-[280px] overflow-y-auto rounded-nb-sm p-1.5',
        'border border-[var(--nb-control-border)] bg-[var(--nb-menu-surface)]',
        'shadow-[var(--nb-shadow-lg)]',
      )}
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {header && (
        <p className="truncate px-2 pb-1 pt-0.5 text-[11px] text-nb-text-3">{header}</p>
      )}
      {visible.map((entry, index) =>
        entry === null ? (
          <div
            key={`separator-${index}`}
            role="separator"
            className="my-1 border-t border-[var(--nb-divider)]"
          />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-nb-xs px-2 text-left text-[13px]',
              'disabled:pointer-events-none disabled:opacity-40',
              entry.danger
                ? 'text-[var(--nb-danger)] hover:bg-[var(--nb-hover)]'
                : 'text-nb-text-2 hover:bg-[var(--nb-hover)] hover:text-nb-text',
            )}
            onClick={() => {
              entry.onSelect();
              onClose();
            }}
          >
            {entry.swatch ? (
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full border border-black/10"
                style={{ backgroundColor: entry.swatch }}
              />
            ) : (
              entry.icon && <entry.icon size={14} className="shrink-0" aria-hidden />
            )}
            <span className="truncate">{entry.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

function hasLater(items: ContextMenuEntry[], index: number): boolean {
  return items.slice(index + 1).some((entry) => entry !== null);
}
