/**
 * The AI tab's switch.
 *
 * Two of them share this shape: "AI knowledge", which decides whether the model
 * may go beyond the notes, and "Agent", which decides whether the panel answers
 * questions or does work. Both are one thing being on or off, and both have to
 * read as a *state* in a 280px pane rather than as a picture — that argument is
 * the reason the Ask panel stopped using a bare sparkle button, and it applies
 * identically to the second switch, so the markup lives here rather than twice.
 */
import { cn } from '@/lib/utils/cn';

export function AiModeSwitch({
  label,
  checked,
  disabled,
  title,
  ariaLabel,
  onChange,
  className,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  /** The sentence the switch stands for. There is no room for it on the line. */
  title?: string;
  ariaLabel?: string;
  onChange(next: boolean): void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-nb-xs px-1.5',
        'text-[11px] font-medium transition-colors duration-[var(--nb-t-fast)]',
        'disabled:pointer-events-none disabled:opacity-50',
        checked
          ? 'text-[var(--nb-accent)]'
          : 'text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text-2',
        className,
      )}
    >
      <span className="truncate">{label}</span>
      <span
        aria-hidden
        className={cn(
          'relative h-[14px] w-6 shrink-0 rounded-full transition-colors duration-[var(--nb-t-fast)]',
          checked ? 'bg-[var(--nb-accent)]' : 'bg-[var(--nb-active)]',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] size-[10px] rounded-full bg-white shadow-sm',
            'transition-[left] duration-[var(--nb-t-fast)]',
            checked ? 'left-3' : 'left-[2px]',
          )}
        />
      </span>
    </button>
  );
}
