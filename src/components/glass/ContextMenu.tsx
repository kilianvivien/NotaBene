/**
 * A right-click menu.
 *
 * One implementation for the note list, every row in the sidebar and the
 * editor, so they all answer a secondary click the same way — with the same
 * geometry, the same dismissal rules, and the same keyboard behaviour. The
 * alternative, a bespoke popup per row type, is how two of them end up
 * disagreeing about whether Escape closes them.
 *
 * It behaves like an AppKit menu rather than a list of buttons:
 *
 * - **One highlight.** The pointer and the arrow keys move the same row; DOM
 *   focus never hops between items. That is what lets the editor keep focus —
 *   and its selection painted in the active colour — while its menu is open.
 * - **Press, drag, release.** A context click opens the menu on the way down,
 *   so releasing the right button over a row chooses it, exactly as in Finder.
 *   Releasing where the menu opened chooses nothing: the pointer sits on the
 *   panel's padding, not on a row.
 * - **A chosen row blinks** before the menu goes, the acknowledgement macOS
 *   gives, and the action runs at once so clipboard access keeps its gesture.
 * - **Type-select.** Typing a label's first letters highlights it.
 *
 * Dismissal listens on `pointerdown` rather than `click`: a menu that survives
 * until mouse-up is a menu you can accidentally activate an item in by
 * releasing over it.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export interface ContextPoint {
  x: number;
  y: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  ariaLabel?: string;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip. A disabled row still owes the reader a reason, and this is the
   * only place a menu has to put one. */
  title?: string;
  /** Marks the current value when the menu is a pop-up button's list. Setting
   * it on any row gives every row the check column, so the labels line up
   * whether or not they are the chosen one. */
  selected?: boolean;
  /** Optional persisted color, used for tag entries without sacrificing text contrast. */
  swatch?: string;
  /** Display form of the keyboard equivalent, right-aligned as in a menu bar. */
  shortcut?: string;
  onSelect(): void;
}

/** An icon button in the row above the items — the editor's formatting. */
export interface ContextToolbarItem {
  id: string;
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  onSelect(): void;
}

/** A `null` entry draws a separator, so a caller can build the list with
 * conditionals without filtering the gaps out afterwards. */
export type ContextMenuEntry = ContextMenuItem | null;

const MARGIN = 8;
/** How long a chosen row stays lit — about AppKit's single blink. */
const BLINK_MS = 90;
const TYPE_SELECT_RESET_MS = 700;

type Row =
  { kind: 'tool'; item: ContextToolbarItem } | { kind: 'item'; item: ContextMenuItem };

export function ContextMenu({
  point,
  items,
  onClose,
  header,
  toolbar,
  footer,
  retainFocus = false,
  openedByKeyboard = false,
}: {
  point: ContextPoint;
  items: ContextMenuEntry[];
  onClose(): void;
  /** Optional label above the items — which course you right-clicked. */
  header?: ReactNode;
  toolbar?: ContextToolbarItem[];
  /** A quiet hint under the items. */
  footer?: ReactNode;
  /** Leave focus where it is (the editor) and swallow the click that
   * dismisses the menu, as a native menu does: clicking away from a text menu
   * closes it without also moving the caret. */
  retainFocus?: boolean;
  /** Opened with the Menu key or ⇧F10: highlight the first row and take focus
   * so VoiceOver reads it. A pointer-opened menu highlights nothing. */
  openedByKeyboard?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ContextPoint>(point);
  const [blinking, setBlinking] = useState<string | null>(null);
  const typed = useRef({ text: '', at: 0 });
  // The blink: the chosen row goes dark for half the interval, then relights.
  const [relit, setRelit] = useState(true);
  useEffect(() => {
    if (!blinking) return;
    setRelit(false);
    const timer = setTimeout(() => setRelit(true), BLINK_MS / 2);
    return () => clearTimeout(timer);
  }, [blinking]);

  const visible = items.filter(
    (entry, index) =>
      // Drop separators that would land first, last, or beside another.
      entry !== null ||
      (index > 0 && items[index - 1] !== null && hasLater(items, index)),
  );
  const rows: Row[] = [
    ...(toolbar ?? []).map((item) => ({ kind: 'tool' as const, item })),
    ...visible.flatMap((entry) =>
      entry && !entry.disabled ? [{ kind: 'item' as const, item: entry }] : [],
    ),
  ];
  const [active, setActive] = useState<string | null>(() =>
    openedByKeyboard ? (rows[0]?.item.id ?? null) : null,
  );

  // Everything the window listeners read, current without re-subscribing.
  const latest = useRef({ rows, active, onClose, blinking });
  latest.current = { rows, active, onClose, blinking };

  const choose = useCallback((row: Row) => {
    if (latest.current.blinking) return;
    // Run first: clipboard access needs the user's gesture, which a timer
    // would outlive. The blink is only the acknowledgement.
    row.item.onSelect();
    setActive(row.item.id);
    setBlinking(row.item.id);
    setTimeout(() => latest.current.onClose(), BLINK_MS);
  }, []);

  useEffect(() => {
    const element = panel.current;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (openedByKeyboard) element?.focus({ preventScroll: true });
    return () => {
      // Hand focus back only if the menu still holds it — an item that opened
      // a dialog has already moved it somewhere that should keep it.
      const current = document.activeElement;
      if (
        (current === document.body || element?.contains(current)) &&
        opener?.isConnected
      )
        opener.focus({ preventScroll: true });
    };
  }, [openedByKeyboard]);

  useEffect(() => {
    const close = () => latest.current.onClose();
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panel.current?.contains(event.target as Node)) return;
      close();
      // A right-click elsewhere opens the next menu there, as it does natively;
      // only the primary click is absorbed.
      if (!retainFocus || event.button !== 0 || event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      // Browsers differ on whether that also cancels the compatibility
      // mousedown, and a click follows regardless; eat both, then stop
      // listening once this press is over so no later click is lost.
      window.addEventListener('mousedown', swallow, true);
      window.addEventListener('click', swallow, true);
      window.addEventListener(
        'pointerup',
        () =>
          setTimeout(() => {
            window.removeEventListener('mousedown', swallow, true);
            window.removeEventListener('click', swallow, true);
          }),
        { capture: true, once: true },
      );
    };
    const move = (step: 1 | -1, within?: 'tool') => {
      const { rows, active } = latest.current;
      const pool = within ? rows.filter((row) => row.kind === within) : rows;
      if (!pool.length) return;
      const index = pool.findIndex((row) => row.item.id === active);
      const next =
        index < 0
          ? step === 1
            ? 0
            : pool.length - 1
          : (index + step + pool.length) % pool.length;
      setActive(pool[next]!.item.id);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (latest.current.blinking) return;
      const { rows, active } = latest.current;
      // A menu shortcut while the menu is up — ⌘C — closes it and still runs.
      if (event.metaKey || event.ctrlKey) {
        close();
        return;
      }
      if (event.key === 'Tab') {
        close();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const current = rows.find((row) => row.item.id === active);
      switch (event.key) {
        case 'Escape':
          close();
          return;
        case 'ArrowDown':
          move(1);
          return;
        case 'ArrowUp':
          move(-1);
          return;
        case 'ArrowRight':
        case 'ArrowLeft':
          if (current?.kind === 'tool') move(event.key === 'ArrowRight' ? 1 : -1, 'tool');
          return;
        case 'Home':
          setActive(rows[0]?.item.id ?? null);
          return;
        case 'End':
          setActive(rows.at(-1)?.item.id ?? null);
          return;
        case 'Enter':
        case ' ':
          if (current) choose(current);
          // Return with nothing highlighted dismisses, as in AppKit.
          else if (event.key === 'Enter') close();
          return;
      }
      if (event.key.length !== 1 || event.isComposing) return;
      const now = Date.now();
      const text =
        (now - typed.current.at > TYPE_SELECT_RESET_MS ? '' : typed.current.text) +
        event.key.toLocaleLowerCase();
      typed.current = { text, at: now };
      const match = rows.find(
        (row) =>
          row.kind === 'item' && row.item.label.toLocaleLowerCase().startsWith(text),
      );
      if (match) setActive(match.item.id);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [retainFocus, choose]);

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

  // One row claiming to be a value makes the whole menu a value list.
  const checkable = visible.some((entry) => entry?.selected !== undefined);
  const lit = (id: string) => active === id && (blinking !== id || relit);

  const rowEvents = (row: Row) => ({
    onPointerMove: () => {
      if (!blinking && active !== row.item.id) setActive(row.item.id);
    },
    onClick: () => choose(row),
    onPointerUp: (event: ReactPointerEvent) => {
      // The release of the right button that opened the menu, over a row.
      if (event.button === 2) choose(row);
    },
  });

  return (
    <div
      ref={panel}
      role="menu"
      tabIndex={-1}
      aria-activedescendant={active ? menuItemId(active) : undefined}
      className={cn(
        'fixed z-[70] max-h-[min(70vh,520px)] min-w-[200px] max-w-[300px] select-none overflow-y-auto rounded-nb-sm p-1.5 outline-none',
        'nb-menu-frost border border-[var(--nb-control-border)]',
        'shadow-[var(--nb-shadow-lg)]',
        blinking && 'pointer-events-none',
      )}
      style={{ left: position.x, top: position.y }}
      // Nothing inside may take focus from the pointer: the highlight is the
      // menu's own state, and the editor keeps its selection meanwhile.
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
      }}
      onMouseDown={(event) => event.preventDefault()}
      onPointerLeave={() => {
        if (!blinking) setActive(null);
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {header && (
        <p className="truncate px-2 pb-1 pt-0.5 text-[11px] text-nb-text-3">{header}</p>
      )}
      {toolbar && toolbar.length > 0 && (
        <div
          role="group"
          className="mb-1 flex gap-0.5 border-b border-[var(--nb-divider)] pb-1.5"
        >
          {toolbar.map((tool) => (
            <button
              key={tool.id}
              id={menuItemId(tool.id)}
              type="button"
              tabIndex={-1}
              role="menuitemcheckbox"
              aria-checked={tool.pressed ?? false}
              aria-label={tool.label}
              title={tool.label}
              className={cn(
                'grid h-7 flex-1 place-items-center rounded-nb-xs',
                lit(tool.id)
                  ? 'bg-[var(--nb-accent)] text-[var(--nb-text-on-accent)]'
                  : tool.pressed
                    ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                    : 'text-nb-text-2',
              )}
              {...rowEvents({ kind: 'tool', item: tool })}
            >
              <tool.icon size={14} aria-hidden />
            </button>
          ))}
        </div>
      )}
      {visible.map((entry, index) =>
        entry === null ? (
          <div
            key={`separator-${index}`}
            role="separator"
            className="mx-2 my-1 border-t border-[var(--nb-divider)]"
          />
        ) : (
          <button
            key={entry.id}
            id={menuItemId(entry.id)}
            type="button"
            tabIndex={-1}
            role={checkable ? 'menuitemradio' : 'menuitem'}
            aria-checked={checkable ? entry.selected === true : undefined}
            aria-disabled={entry.disabled || undefined}
            aria-label={entry.ariaLabel}
            title={entry.title}
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-nb-xs px-2 text-left text-[13px]',
              // A disabled row keeps its pointer events, so a `title` saying why
              // it is disabled can still be read, but it never lights up: a row
              // that lights up under the pointer is a row claiming to be
              // available.
              entry.disabled
                ? 'text-nb-text-2 opacity-40'
                : lit(entry.id)
                  ? 'bg-[var(--nb-accent)] text-[var(--nb-text-on-accent)]'
                  : entry.danger
                    ? 'text-[var(--nb-danger)]'
                    : 'text-nb-text',
            )}
            {...(entry.disabled ? {} : rowEvents({ kind: 'item', item: entry }))}
          >
            {checkable ? (
              <span aria-hidden className="grid size-3.5 shrink-0 place-items-center">
                {entry.selected && (
                  <Check
                    size={13}
                    className={lit(entry.id) ? undefined : 'text-[var(--nb-accent)]'}
                  />
                )}
              </span>
            ) : entry.swatch ? (
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full border border-black/10"
                style={{ backgroundColor: entry.swatch }}
              />
            ) : (
              entry.icon && (
                <entry.icon
                  size={14}
                  className={cn('shrink-0', !lit(entry.id) && 'text-nb-text-2')}
                  aria-hidden
                />
              )
            )}
            <span className="truncate">{entry.label}</span>
            {entry.shortcut && (
              <span
                aria-hidden
                className={cn(
                  'ml-auto pl-5 text-[12px] tracking-wide',
                  lit(entry.id) ? 'opacity-80' : 'text-nb-text-3',
                )}
              >
                {entry.shortcut}
              </span>
            )}
          </button>
        ),
      )}
      {footer && (
        <p className="mt-1 border-t border-[var(--nb-divider)] px-2 pt-1.5 text-[11px] leading-snug text-nb-text-3">
          {footer}
        </p>
      )}
    </div>
  );
}

function menuItemId(id: string): string {
  return `nb-menu-item-${id.replace(/[^\w-]/g, '_')}`;
}

function hasLater(items: ContextMenuEntry[], index: number): boolean {
  return items.slice(index + 1).some((entry) => entry !== null);
}
