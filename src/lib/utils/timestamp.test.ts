import { describe, expect, it } from 'vitest';
import { formatTimestamp } from './timestamp';

describe('formatTimestamp', () => {
  it('shows the date and the minute, never the seconds', () => {
    const shown = formatTimestamp('2026-09-26T18:27:50', 'en-US');
    expect(shown).toContain('Sep 26, 2026');
    expect(shown).toMatch(/6:27\s?PM/);
    expect(shown).not.toContain(':50');
  });

  it('follows the interface language', () => {
    expect(formatTimestamp('2026-09-26T18:27:50', 'fr')).toContain('26 sept. 2026');
  });

  it('shows nothing for a date it cannot read', () => {
    expect(formatTimestamp('not a date', 'en')).toBe('');
  });
});
