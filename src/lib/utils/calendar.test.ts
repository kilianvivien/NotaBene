import { describe, expect, it } from 'vitest';
import {
  addMonths,
  firstDayOfWeek,
  isSameDay,
  monthGrid,
  weekdayLabels,
} from './calendar';

describe('addMonths', () => {
  it('clamps rather than overflowing into the month after next', () => {
    const next = addMonths(new Date(2026, 0, 31), 1);
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2026, 1, 28]);
  });

  it('finds 29 February in a leap year', () => {
    const next = addMonths(new Date(2028, 0, 31), 1);
    expect(next.getDate()).toBe(29);
  });

  it('goes backwards across a year boundary', () => {
    const previous = addMonths(new Date(2026, 0, 15), -1);
    expect([previous.getFullYear(), previous.getMonth()]).toEqual([2025, 11]);
  });
});

describe('firstDayOfWeek', () => {
  it('starts the week on Sunday in the United States', () => {
    expect(firstDayOfWeek('en-US')).toBe(0);
  });

  it('starts the week on Monday in France', () => {
    expect(firstDayOfWeek('fr-FR')).toBe(1);
  });

  it('does not throw on a locale tag it cannot parse', () => {
    expect(() => firstDayOfWeek('not a locale')).not.toThrow();
  });
});

describe('weekdayLabels', () => {
  it('gives seven labels beginning on the locale’s first day', () => {
    const labels = weekdayLabels('fr-FR');
    expect(labels).toHaveLength(7);
    // Monday first in French; the exact spelling belongs to Intl, not to us.
    expect(labels[0]?.toLowerCase()).toMatch(/^lun/);
  });
});

describe('monthGrid', () => {
  it('always draws six rows, so the grid does not jump between months', () => {
    for (const month of [new Date(2026, 1, 1), new Date(2026, 2, 1), new Date(2026, 7, 1)]) {
      expect(monthGrid(month, 'en-GB')).toHaveLength(6);
    }
  });

  it('starts on the locale’s first weekday', () => {
    const monday = monthGrid(new Date(2026, 7, 1), 'fr-FR')[0]?.[0];
    const sunday = monthGrid(new Date(2026, 7, 1), 'en-US')[0]?.[0];
    expect(monday?.getDay()).toBe(1);
    expect(sunday?.getDay()).toBe(0);
  });

  it('pads with the neighbouring months rather than leaving holes', () => {
    // 1 August 2026 is a Saturday, so a Monday-first grid opens in July.
    const grid = monthGrid(new Date(2026, 7, 1), 'fr-FR');
    const first = grid[0]?.[0];
    expect(first?.getMonth()).toBe(6);
    expect(grid.flat()).toHaveLength(42);
  });

  it('contains every day of the month exactly once', () => {
    const grid = monthGrid(new Date(2026, 7, 1), 'en-GB').flat();
    for (let day = 1; day <= 31; day += 1) {
      const target = new Date(2026, 7, day);
      expect(grid.filter((cell) => isSameDay(cell, target))).toHaveLength(1);
    }
  });

  it('gives midnight-local cells, so a due time cannot shift the day', () => {
    for (const cell of monthGrid(new Date(2026, 7, 1), 'en-GB').flat()) {
      expect([cell.getHours(), cell.getMinutes(), cell.getSeconds()]).toEqual([0, 0, 0]);
    }
  });
});
