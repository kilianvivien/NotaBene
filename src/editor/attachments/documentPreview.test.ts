import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { attachmentPreviewKind } from '@/lib/attachments/previewSupport';
import { readAttachmentText, rtfToText } from './documentPreview';
import { renderOdtHtml } from './odtPreview';

describe('attachment document previews', () => {
  it('recognises document formats by MIME or extension', () => {
    expect(attachmentPreviewKind('paper.bin', 'application/pdf')).toBe('pdf');
    expect(attachmentPreviewKind('notes.docx', 'application/octet-stream')).toBe('docx');
    expect(attachmentPreviewKind('notes.odt', 'application/octet-stream')).toBe('odt');
    expect(attachmentPreviewKind('README.md', '')).toBe('markdown');
    expect(attachmentPreviewKind('letter.rtf', 'application/octet-stream')).toBe('rtf');
    expect(attachmentPreviewKind('plain.txt', '')).toBe('text');
    expect(attachmentPreviewKind('lecture.mp3', '')).toBe('audio');
    expect(attachmentPreviewKind('archive.zip', 'application/zip')).toBeNull();
  });

  it('reads Markdown and text payloads without changing their content', async () => {
    await expect(
      readAttachmentText(new Blob(['# Heading\n\nText'], { type: 'text/markdown' })),
    ).resolves.toBe('# Heading\n\nText');
  });

  it('turns RTF controls and escapes into readable text', () => {
    const source =
      String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}\uc1 Hello \b world\b0\par ` +
      String.raw`Fran\'e7ais \u8212? test\tab done.}`;

    expect(rtfToText(source)).toBe('Hello world\nFrançais — test\tdone.');
  });

  it('omits metadata and embedded destinations from RTF previews', () => {
    const source =
      String.raw`{\rtf1{\info{\title Private title}}Visible` +
      String.raw`{\pict\pngblip 89504e47}\par text}`;

    expect(rtfToText(source)).toBe('Visible\ntext');
  });

  it('renders ODT structure and whitelisted formatting locally', () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
      <office:document-content
        xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
        xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
        xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
        xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
        xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0">
        <office:automatic-styles>
          <style:style style:name="Centered" style:family="paragraph">
            <style:paragraph-properties fo:text-align="center"/>
          </style:style>
          <style:style style:name="Bold" style:family="text">
            <style:text-properties fo:font-weight="bold"/>
          </style:style>
        </office:automatic-styles>
        <office:body>
          <office:text>
            <text:h text:outline-level="2">Heading</text:h>
            <text:p text:style-name="Centered">Hello <text:span text:style-name="Bold">ODT</text:span></text:p>
            <table:table><table:table-row><table:table-cell><text:p>Cell</text:p></table:table-cell></table:table-row></table:table>
          </office:text>
        </office:body>
      </office:document-content>`;
    const bytes = zipSync({
      mimetype: strToU8('application/vnd.oasis.opendocument.text'),
      'content.xml': strToU8(content),
    });

    const html = renderOdtHtml(bytes);
    expect(html).toContain('<h2>Heading</h2>');
    expect(html).toContain('text-align: center');
    expect(html).toContain('font-weight: bold');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>');
  });
});
