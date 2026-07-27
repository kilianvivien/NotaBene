import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiRichText } from './AiRichText';

describe('AiRichText', () => {
  it('renders model Markdown as structured, readable content', () => {
    const html = renderToStaticMarkup(
      <AiRichText
        markdown={'## Summary\n\nThis is **important**.\n\n> [!WARN]\n> Check the date.'}
      />,
    );

    expect(html).toContain('<h4');
    expect(html).toContain('<strong>important</strong>');
    expect(html).toContain('<aside');
    expect(html).not.toContain('**important**');
    expect(html).not.toContain('[!WARN]');
  });

  it('does not turn unsafe model-generated links into anchors', () => {
    const html = renderToStaticMarkup(
      <AiRichText markdown={'[Do not open](javascript:alert(1))'} />,
    );

    expect(html).toContain('Do not open');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('javascript:');
  });
});
