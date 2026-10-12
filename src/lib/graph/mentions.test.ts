import { describe, expect, it } from 'vitest';
import { findMention, isMentionableTitle, mentionSnippet } from './mentions';

describe('findMention', () => {
  it('finds a whole title whatever its case, at its place in the original', () => {
    const text = 'We saw DAMPING today.';
    const match = findMention(text, 'Damping');
    expect(match && text.slice(match.start, match.end)).toBe('DAMPING');
  });

  it('does not match inside a longer word', () => {
    expect(findMention('Overdamping and damping_factor', 'Damping')).toBeNull();
    expect(findMention('Les amortissements', 'amortissement')).toBeNull();
  });

  it('moves past a partial match to a whole one', () => {
    const text = 'Overdamping, then damping.';
    expect(findMention(text, 'damping')?.start).toBe(text.lastIndexOf('damping'));
  });

  it('treats accented letters as letters at a boundary', () => {
    expect(findMention('la série étudiée', 'série')).not.toBeNull();
    expect(findMention('présérie', 'série')).toBeNull();
  });

  it('matches a title made of punctuation literally', () => {
    expect(findMention('Notes on C++ (2026) today', 'C++ (2026)')).not.toBeNull();
    expect(findMention('a.b.c.d', 'a+b+')).toBeNull();
  });

  it('never looks for a title under four characters', () => {
    expect(isMentionableTitle('Lab')).toBe(false);
    expect(isMentionableTitle(' Labs ')).toBe(true);
    expect(findMention('in the lab today', 'Lab')).toBeNull();
  });
});

describe('mentionSnippet', () => {
  it('leads into the mention and marks a cut start', () => {
    const text = `${'x'.repeat(200)} then\nDamping here`;
    const snippet = mentionSnippet(text, findMention(text, 'Damping')!);
    expect(snippet.startsWith('… ')).toBe(true);
    expect(snippet).toContain('then Damping here');
  });
});
