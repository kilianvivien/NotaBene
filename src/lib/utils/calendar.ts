/**
 * Month-grid arithmetic, shared by the date picker and the task calendar.
 *
 * Kept pure and kept here because both surfaces have to agree about which day a
 * cell is: a picker that starts the week on Monday and a calendar that starts it
 * on Sunday would be two different products in the same window.
 *
 * Everything works in local time. A task due at 09:00 belongs to the day the
 * student sees on their wall, not to whatever day that instant falls on in UTC.
 */

export const DAYS_IN_WEEK = 7;

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Month arithmetic that clamps instead of overflowing — 31 Jan + 1 month is
 * 28 Feb, not 3 March, which is what `setMonth` alone would give. */
export function addMonths(date: Date, months: number): Date {
  const copy = new Date(date);
  const day = copy.getDate();
  copy.setDate(1);
  copy.setMonth(copy.getMonth() + months);
  const lastDay = new Date(copy.getFullYear(), copy.getMonth() + 1, 0).getDate();
  copy.setDate(Math.min(day, lastDay));
  return copy;
}

/**
 * Which weekday a week starts on, as 0 = Sunday.
 *
 * `Intl.Locale.getWeekInfo` is the right answer and is not everywhere yet —
 * notably not in every WebKit the desktop build might run on. The fallback is
 * the honest approximation rather than a table of every locale: the anglophone
 * Sunday-start countries, and Monday for the rest, which covers both languages
 * NotaBene ships in.
 */
export function firstDayOfWeek(locale: string): number {
  type WithWeekInfo = Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  try {
    const resolved = new Intl.Locale(locale) as WithWeekInfo;
    const info = resolved.getWeekInfo?.() ?? resolved.weekInfo;
    // The spec counts Monday as 1 and Sunday as 7; `Date.getDay` counts Sunday
    // as 0, and every consumer here speaks the latter.
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    // An unparseable locale tag is not worth failing a calendar over.
  }
  const language = locale.toLowerCase();
  const sundayFirst = ['en-us', 'en-ca', 'en-au', 'ja', 'he', 'pt-br'];
  return sundayFirst.some((tag) => language.startsWith(tag)) ? 0 : 1;
}

/** Short weekday initials, starting on the locale's first day. */
export function weekdayLabels(locale: string): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const first = firstDayOfWeek(locale);
  // 2024-01-07 was a Sunday, so day N of the week is the 7th plus N.
  return Array.from({ length: DAYS_IN_WEEK }, (_, index) =>
    formatter.format(new Date(2024, 0, 7 + ((first + index) % DAYS_IN_WEEK))),
  );
}

/**
 * The weeks a month is drawn as, including the neighbouring days that fill the
 * first and last rows.
 *
 * Always six rows. A grid that is five rows in February and six in March jumps
 * under the pointer as you page through the year, and a fixed height is worth
 * more than the one blank row it sometimes costs.
 */
export function monthGrid(month: Date, locale: string): Date[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() - firstDayOfWeek(locale) + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  const start = addDays(first, -offset);

  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: DAYS_IN_WEEK }, (_, day) =>
      startOfDay(addDays(start, week * DAYS_IN_WEEK + day)),
    ),
  );
}

/** An ISO instant for a day at a given wall-clock time. */
export function atTime(day: Date, hours: number, minutes: number): string {
  const copy = new Date(day);
  copy.setHours(hours, minutes, 0, 0);
  return copy.toISOString();
}
