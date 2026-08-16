import { describe, expect, it } from 'vitest';
import { extractPage, snapshotFilename, snapshotMarkdown } from './webPage';

const ARTICLE = `<!doctype html>
<html>
  <head><title>Thermodynamics — the second law | Physics Weekly</title></head>
  <body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <header><h1>Site furniture nobody wants</h1></header>
    <article>
      <h1>The second law</h1>
      <p>Entropy of an isolated system never decreases. This is the sentence the
      whole article exists to explain, and it is long enough that Readability
      will treat the block around it as the real content rather than as another
      piece of navigation furniture sitting at the top of the page.</p>
      <p>A second paragraph, also of a respectable length, so that the scoring
      heuristic has something to hold on to and does not decide the sidebar is
      more interesting than the body of the piece itself.</p>
      <ul><li>Heat flows from hot to cold</li><li>Work is not free</li></ul>
      <p>See the <a href="/glossary/entropy">glossary</a> and this
      <img src="/diagram.png" alt="a diagram">.</p>
    </article>
    <footer><p>© Physics Weekly</p></footer>
    <script>window.track('page-view');</script>
  </body>
</html>`;

describe('extractPage', () => {
  it('keeps the article and drops the furniture around it', () => {
    const page = extractPage(ARTICLE, 'https://example.com/physics/second-law');

    expect(page.markdown).toContain('Entropy of an isolated system');
    expect(page.markdown).toContain('Heat flows from hot to cold');
    expect(page.markdown).not.toContain('Site furniture');
    expect(page.fellBack).toBe(false);
  });

  it('never carries a script through, whatever the page tried', () => {
    const page = extractPage(ARTICLE, 'https://example.com/physics/second-law');
    expect(page.markdown).not.toContain('window.track');
    expect(page.markdown.toLowerCase()).not.toContain('<script');
  });

  it('absolutises links so they still work outside the site', () => {
    const page = extractPage(ARTICLE, 'https://example.com/physics/second-law');
    expect(page.markdown).toContain('https://example.com/glossary/entropy');
  });

  it('drops images rather than leaving a note that phones the site', () => {
    const page = extractPage(ARTICLE, 'https://example.com/physics/second-law');
    expect(page.markdown).not.toContain('diagram.png');
    expect(page.markdown).not.toContain('![');
  });

  it('falls back to the body rather than failing on an unreadable page', () => {
    const page = extractPage(
      '<html><body><div>Just a sentence, loose in the page.</div></body></html>',
      'https://example.com/x',
    );
    expect(page.markdown).toContain('Just a sentence');
  });

  it('refuses a page with no text at all', () => {
    expect(() => extractPage('<html><body></body></html>', 'https://example.com/x')).toThrow(
      /empty_page/,
    );
  });

  it('names the page from its URL when it has no title', () => {
    const page = extractPage(
      '<html><body><p>Some words that are long enough to survive.</p></body></html>',
      'https://example.com/notes/second-law',
    );
    expect(page.title).toBe('second law');
  });
});

describe('snapshotMarkdown', () => {
  it('carries the source and the date into the text itself', () => {
    const page = extractPage(ARTICLE, 'https://example.com/physics/second-law');
    const snapshot = snapshotMarkdown(
      page,
      'https://example.com/physics/second-law',
      '2026-08-15T10:00:00.000Z',
    );

    // In the Markdown, not in chrome around it: this has to survive being
    // turned into a note.
    expect(snapshot).toContain('https://example.com/physics/second-law');
    expect(snapshot).toContain('2026-08-15');
    expect(snapshot.startsWith('# ')).toBe(true);
  });
});

describe('snapshotFilename', () => {
  it('ends in .md, which is what makes preview and import work unchanged', () => {
    expect(snapshotFilename('The second law')).toBe('The second law.md');
  });

  it('strips what a filesystem would refuse', () => {
    expect(snapshotFilename('a/b:c*d?"e<f>g|h')).toBe('a b c d e f g h.md');
  });

  it('still produces a name for a title of nothing but punctuation', () => {
    expect(snapshotFilename('///')).toBe('Web page.md');
  });
});
