/**
 * The two string helpers every task surface needs.
 *
 * Both were copied into three components each — the row, the detail pane, the
 * inspector — and a fourth copy is how a date ends up formatted one way in the
 * list and another way beside it.
 */

/** Title-cases an enum member into its `tasks.*` key suffix. */
export function keySuffix(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The shape the note list uses, plus the time when the deadline has one. */
export function formatTaskDate(iso: string, locale: string): string {
  const date = new Date(iso);
  const midnight = date.getHours() === 0 && date.getMinutes() === 0;
  return date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(midnight ? {} : { hour: 'numeric', minute: '2-digit' }),
  });
}
