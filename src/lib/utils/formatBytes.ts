/**
 * Byte counts, in the reader's locale.
 *
 * Decimal units rather than binary ones: this number sits next to what Finder
 * reports for the same folder, and a "MB" that disagreed with the Finder's
 * would read as a bug in NotaBene rather than as a unit convention.
 */
export function formatBytes(value: number, locale: 'en' | 'fr'): string {
  const [unit, divisor] =
    value >= 1_000_000_000
      ? (['gigabyte', 1_000_000_000] as const)
      : value >= 1_000_000
        ? (['megabyte', 1_000_000] as const)
        : value >= 1_000
          ? (['kilobyte', 1_000] as const)
          : (['byte', 1] as const);
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  }).format(value / divisor);
}
