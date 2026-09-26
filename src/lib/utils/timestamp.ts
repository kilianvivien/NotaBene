/**
 * A created or modified time, as the inspectors show it: "Sep 26, 2026, 6:27 PM".
 *
 * Seconds are left out on purpose. `toLocaleString()` printed them, which read
 * as a log line beside the note list's "Sep 26" and told the student nothing a
 * minute does not. Versions keep their seconds — two snapshots can share a
 * minute, and there the difference is the point.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

export function formatTimestamp(iso: string, locale: string): string {
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    formatters.set(locale, formatter);
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : formatter.format(date);
}
