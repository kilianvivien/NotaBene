import { describe, expect, it } from 'vitest';
import { excerptSnippet } from './wikipediaExcerpt';

describe('excerptSnippet', () => {
  it('turns a search match into the marker the snippet renderer knows', () => {
    expect(
      excerptSnippet('président de la <span class="searchmatch">HATVP</span> depuis'),
    ).toBe('président de la <mark>HATVP</mark> depuis');
  });

  it('keeps the text of markup it does not recognise, and drops the markup', () => {
    expect(excerptSnippet('a <b>bold</b> <i>claim</i>')).toBe('a bold claim');
  });

  it('marks the whole of a match that has markup inside it', () => {
    expect(excerptSnippet('<span class="searchmatch">a <b>b</b></span>')).toBe(
      '<mark>a </mark><mark>b</mark>',
    );
  });

  it('decodes entities rather than showing them', () => {
    expect(excerptSnippet('Bourbon &amp; Or&#233;ans')).toBe('Bourbon & Oréans');
  });

  /** The whole reason the excerpt is parsed instead of interpolated. */
  it('cannot carry an element through', () => {
    const out = excerptSnippet('<script>alert(1)</script><img src=x onerror=y>hi');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror');
  });

  it('collapses the whitespace wiki markup leaves behind', () => {
    expect(excerptSnippet('  one\n\n  two  ')).toBe('one two');
  });

  it('truncates on a word and never inside a marker', () => {
    const long = `${'word '.repeat(60)}<span class="searchmatch">match</span>`;
    const out = excerptSnippet(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/<mark>[^<]*$/);
    expect((out.match(/<mark>/g) ?? []).length).toBe(
      (out.match(/<\/mark>/g) ?? []).length,
    );
  });

  it('says nothing when there was nothing to say', () => {
    expect(excerptSnippet('')).toBe('');
    expect(excerptSnippet('<span></span>')).toBe('');
  });
});
