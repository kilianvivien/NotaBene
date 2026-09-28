/**
 * What an exported HTML file must never carry, whatever the note held.
 *
 * The `svg` of a drawing or mind map can arrive from a `notabene-drawing`
 * fence in any imported Markdown, a model's answer or an MCP write, and a
 * link can arrive as `javascript:`. The export is a file the student opens in
 * a browser with every exported note inside it.
 */
import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '@/editor/markdown';
import { completeHtmlDocument, docToSemanticHtml } from './render';

const HOSTILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';

describe('HTML export of untrusted content', () => {
  it('draws a smuggled SVG as an inert image', () => {
    const doc = markdownToDoc(
      ['```notabene-drawing', JSON.stringify({ svg: HOSTILE_SVG, title: 'x' }), '```'].join(
        '\n',
      ),
    );
    const html = docToSemanticHtml(doc);
    expect(html).not.toMatch(/<svg|<script|onload=/i);
    expect(html).toContain('<img src="data:image/svg+xml;charset=utf-8,');
  });

  it('keeps the words of a javascript: link and drops the target', () => {
    const html = docToSemanticHtml(
      markdownToDoc('[click me](javascript:fetch(document.body.innerHTML))'),
    );
    expect(html).toContain('click me');
    expect(html).not.toMatch(/href=|javascript:/i);
  });

  it('keeps ordinary, mail, anchor and PDF-citation links', () => {
    const html = docToSemanticHtml(
      markdownToDoc(
        '[a](https://example.org) [b](mailto:x@y.z) [c](notabene-pdf:att?page=2)',
      ),
    );
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('href="mailto:x@y.z"');
    expect(html).toContain('href="notabene-pdf:att?page=2"');
  });

  it('forbids script in the exported page itself', () => {
    const page = completeHtmlDocument('Notes', '<p>x</p>');
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="script-src 'none';`);
  });
});
