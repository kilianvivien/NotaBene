/**
 * The tick control a to-do needs.
 *
 * `FieldToggle` is a switch, which reads as "this setting is on" — the wrong
 * thing to say about a task. This is a checkbox, and it carries the third state
 * the task model has: clicking cycles todo → in progress → done → todo, so one
 * control drives the whole status without a menu. The half-filled middle state
 * is deliberately not a "mixed" checkbox: nothing here is partially selected.
 */
import { Check, Minus } from 'lucide-react';
import type { TaskStatus } from '@/lib/schema';
import { cn } from '@/lib/utils/cn';

/**
 * Ticking the box means "done", from any state.
 *
 * It cycled todo → inProgress → done, which read well in the abstract and was
 * wrong in the hand: finishing something is overwhelmingly the most common
 * thing a student does to a task, and that made it cost two clicks while
 * leaving a half-filled box behind on the first. "In progress" is set from the
 * status menu, where it is a deliberate choice rather than a stop on the way.
 */
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: 'done',
  inProgress: 'done',
  done: 'todo',
};

export function GlassCheckbox({
  status,
  onChange,
  label,
  disabled = false,
  size = 'md',
}: {
  status: TaskStatus;
  onChange(next: TaskStatus): void;
  /** Accessible name — the row's title. The control itself has no text. */
  label: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const box = size === 'sm' ? 'size-[15px]' : 'size-[17px]';
  const glyph = size === 'sm' ? 10 : 12;

  return (
    <button
      type="button"
      role="checkbox"
      // A screen reader gets the honest three-state story: `mixed` is what ARIA
      // has for "started but not finished", and it is the closest true reading
      // of "in progress" available to a checkbox role.
      aria-checked={status === 'done' ? true : status === 'inProgress' ? 'mixed' : false}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        // Ticking a task off must not also open it. The row's button is a
        // sibling rather than an ancestor, so this only guards against a
        // future clickable wrapper — cheap insurance against a regression
        // that would be felt rather than seen.
        event.stopPropagation();
        onChange(NEXT_STATUS[status]);
      }}
      className={cn(
        box,
        'flex shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-[var(--nb-t-fast)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--nb-accent-ring)]',
        'disabled:pointer-events-none disabled:opacity-40',
        status === 'done'
          ? 'border-[var(--nb-success)] bg-[var(--nb-success)] text-white'
          : status === 'inProgress'
            ? 'border-[var(--nb-accent)] bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
            : 'border-[var(--nb-control-border)] hover:border-[var(--nb-accent)]',
      )}
    >
      {status === 'done' && <Check size={glyph} strokeWidth={3} aria-hidden />}
      {status === 'inProgress' && <Minus size={glyph} strokeWidth={3} aria-hidden />}
    </button>
  );
}
