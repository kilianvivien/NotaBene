import * as pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';
import type {
  Content,
  ContentText,
  Style,
  TableCell,
  TDocumentDefinitions,
} from 'pdfmake/interfaces';
import type { DocNode, Note } from '@/lib/schema';

pdfMake.addVirtualFileSystem(pdfFonts);

const COLORS = {
  text: '#24221F',
  muted: '#77736D',
  accent: '#A8602D',
  border: '#CBC6BE',
  surface: '#F6F3EE',
  highlight: '#FFF0A8',
};

function safeLink(value: unknown): string | undefined {
  const href = String(value ?? '').trim();
  return /^(https?:|mailto:)/i.test(href) ? href : undefined;
}

function textOf(node: DocNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'math' || node.type === 'mathBlock')
    return String(node.attrs?.latex ?? '');
  return (node.content ?? []).map(textOf).join('');
}

function printableSvg(svg: string): string {
  if (!/<svg\b/i.test(svg)) return svg;
  const hasWidth = /<svg\b[^>]*\bwidth\s*=/i.test(svg);
  const hasHeight = /<svg\b[^>]*\bheight\s*=/i.test(svg);
  const hasViewBox = /<svg\b[^>]*\bviewBox\s*=/i.test(svg);
  const attributes = [
    hasWidth ? '' : ' width="620"',
    hasHeight ? '' : ' height="360"',
    hasViewBox ? '' : ' viewBox="0 0 620 360"',
  ].join('');
  return svg.replace(/<svg\b/i, `<svg${attributes}`);
}

function inline(node: DocNode): ContentText[] {
  if (node.type === 'wikiLink') {
    return [{ text: String(node.attrs?.title ?? ''), color: COLORS.accent }];
  }
  if (node.type === 'math') {
    return [
      {
        text: String(node.attrs?.latex ?? ''),
        font: 'Roboto',
        italics: true,
      },
    ];
  }
  if (node.type !== 'text') return (node.content ?? []).flatMap(inline);

  const marks = node.marks ?? [];
  const decorations: Array<'lineThrough' | 'underline'> = [];
  if (marks.some((mark) => mark.type === 'strike')) decorations.push('lineThrough');
  if (marks.some((mark) => mark.type === 'underline')) decorations.push('underline');
  const result: ContentText = {
    text: node.text ?? '',
    bold: marks.some((mark) => mark.type === 'bold'),
    italics: marks.some((mark) => mark.type === 'italic'),
    background: marks.some((mark) => mark.type === 'highlight')
      ? COLORS.highlight
      : undefined,
    font: marks.some((mark) => mark.type === 'code') ? 'Roboto' : undefined,
    decoration: decorations.length ? decorations : undefined,
  };
  const href = safeLink(marks.find((mark) => mark.type === 'link')?.attrs?.href);
  if (href) {
    result.link = href;
    result.color = '#2768AD';
    result.decoration = [...decorations, 'underline'];
  }
  return [result];
}

function paragraphContent(node: DocNode): Content {
  return {
    text: (node.content ?? []).flatMap(inline),
    margin: [0, 0, 0, 7],
  };
}

function listItem(node: DocNode): Content {
  const content = blocks(node.content ?? []);
  return content.length === 1 ? content[0]! : { stack: content };
}

function callout(node: DocNode): Content {
  const kind = String(node.attrs?.kind ?? 'info');
  const palette =
    kind === 'warn'
      ? { accent: '#A45B25', fill: '#FFF4E8' }
      : kind === 'important'
        ? { accent: '#9D4D67', fill: '#FAEFF3' }
        : { accent: COLORS.accent, fill: '#F8F0E9' };
  const label = kind === 'warn' ? 'WARNING' : kind.toUpperCase();
  const cell = {
    stack: [
      {
        text: label,
        bold: true,
        fontSize: 8,
        color: palette.accent,
        characterSpacing: 0.7,
        margin: [0, 0, 0, 5],
      },
      ...blocks(node.content ?? []),
    ],
    fillColor: palette.fill,
    border: [true, false, false, false] as [boolean, boolean, boolean, boolean],
    borderColor: [palette.accent, palette.accent, palette.accent, palette.accent] as [
      string,
      string,
      string,
      string,
    ],
  } as TableCell;
  return {
    table: { widths: ['*'], body: [[cell]], dontBreakRows: true },
    layout: {
      paddingLeft: () => 11,
      paddingRight: () => 11,
      paddingTop: () => 9,
      paddingBottom: () => 4,
      vLineWidth: (index: number) => (index === 0 ? 3 : 0),
      hLineWidth: () => 0,
    },
    margin: [0, 5, 0, 11],
  };
}

function blocks(
  nodes: DocNode[],
  assetUrls: ReadonlyMap<string, string> = new Map(),
): Content[] {
  const result: Content[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        result.push(paragraphContent(node));
        break;
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 1)));
        result.push({
          text: (node.content ?? []).flatMap(inline),
          style: `heading${level}`,
        });
        break;
      }
      case 'bulletList':
        result.push({
          ul: (node.content ?? []).map(listItem),
          margin: [13, 0, 0, 8],
          markerColor: COLORS.accent,
        });
        break;
      case 'orderedList':
        result.push({
          ol: (node.content ?? []).map(listItem),
          start: Number(node.attrs?.start ?? 1),
          margin: [13, 0, 0, 8],
          markerColor: COLORS.accent,
        });
        break;
      case 'taskList':
        result.push({
          ul: (node.content ?? []).map((item) => ({
            text: [
              { text: item.attrs?.checked ? '☑  ' : '☐  ', color: COLORS.accent },
              ...inline(item),
            ],
          })),
          type: 'none',
          margin: [13, 0, 0, 8],
        });
        break;
      case 'callout':
        result.push(callout(node));
        break;
      case 'blockquote':
        result.push({
          table: {
            widths: ['*'],
            body: [
              [
                {
                  stack: blocks(node.content ?? []),
                  border: [true, false, false, false],
                  borderColor: ['#AAA59D', '#AAA59D', '#AAA59D', '#AAA59D'],
                  color: '#57534E',
                } as TableCell,
              ],
            ],
          },
          layout: {
            paddingLeft: () => 10,
            paddingRight: () => 0,
            paddingTop: () => 3,
            paddingBottom: () => 0,
            vLineWidth: (index: number) => (index === 0 ? 2 : 0),
            hLineWidth: () => 0,
          },
          margin: [0, 4, 0, 9],
        });
        break;
      case 'toggle':
        result.push({
          stack: [
            {
              text: String(node.attrs?.summary ?? 'Details'),
              bold: true,
              color: COLORS.accent,
              margin: [0, 0, 0, 4],
            },
            ...blocks(node.content ?? []),
          ],
          margin: [10, 5, 0, 8],
        });
        break;
      case 'codeBlock':
        result.push({
          text: textOf(node),
          font: 'Roboto',
          fontSize: 9,
          preserveLeadingSpaces: true,
          background: COLORS.surface,
          margin: [8, 7, 8, 11],
        });
        break;
      case 'mathBlock':
        result.push({
          text: String(node.attrs?.latex ?? ''),
          alignment: 'center',
          italics: true,
          margin: [0, 6, 0, 12],
        });
        break;
      case 'table': {
        const rows = node.content ?? [];
        const columnCount = Math.max(1, ...rows.map((row) => row.content?.length ?? 0));
        result.push({
          table: {
            headerRows: rows[0]?.content?.some((cell) => cell.type === 'tableHeader')
              ? 1
              : 0,
            widths: Array.from({ length: columnCount }, () => '*'),
            body: rows.map((row) =>
              (row.content ?? []).map(
                (cell) =>
                  ({
                    stack: blocks(cell.content ?? []),
                    bold: cell.type === 'tableHeader',
                    fillColor: cell.type === 'tableHeader' ? COLORS.surface : undefined,
                  }) as TableCell,
              ),
            ),
          },
          layout: {
            hLineColor: () => COLORS.border,
            vLineColor: () => COLORS.border,
            hLineWidth: () => 0.6,
            vLineWidth: () => 0.6,
            paddingLeft: () => 7,
            paddingRight: () => 7,
            paddingTop: () => 5,
            paddingBottom: () => 5,
          },
          margin: [0, 5, 0, 11],
        });
        break;
      }
      case 'image': {
        const source = assetUrls.get(String(node.attrs?.assetId ?? ''));
        if (source) {
          result.push({
            image: source,
            fit: [470, 350],
            alignment: 'center',
            margin: [0, 5, 0, 4],
          });
          if (node.attrs?.caption) {
            result.push({
              text: String(node.attrs.caption),
              style: 'caption',
            });
          }
        } else {
          result.push({ text: `[${String(node.attrs?.caption ?? 'Image')}]` });
        }
        break;
      }
      case 'drawing':
      case 'mindMap':
        if (typeof node.attrs?.svg === 'string' && node.attrs.svg) {
          result.push({
            svg: printableSvg(node.attrs.svg),
            fit: [470, 330],
            alignment: 'center',
            margin: [0, 5, 0, 4],
          });
          if (node.attrs?.title) {
            result.push({ text: String(node.attrs.title), style: 'caption' });
          }
        }
        break;
      case 'horizontalRule':
        result.push({
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: 487,
              y2: 0,
              lineWidth: 0.7,
              lineColor: COLORS.border,
            },
          ],
          margin: [0, 8, 0, 12],
        });
        break;
      default:
        if (textOf(node)) result.push({ text: textOf(node), margin: [0, 0, 0, 7] });
    }
  }
  return result;
}

const styles: Record<string, Style> = {
  title: {
    fontSize: 25,
    bold: true,
    lineHeight: 1.12,
    color: COLORS.text,
    margin: [0, 0, 0, 8],
  },
  metadata: {
    fontSize: 8.5,
    color: COLORS.muted,
    margin: [0, 0, 0, 17],
  },
  heading1: {
    fontSize: 19,
    bold: true,
    color: COLORS.text,
    margin: [0, 14, 0, 7],
  },
  heading2: {
    fontSize: 15,
    bold: true,
    color: COLORS.text,
    margin: [0, 12, 0, 6],
  },
  heading3: {
    fontSize: 12.5,
    bold: true,
    color: COLORS.accent,
    margin: [0, 10, 0, 5],
  },
  caption: {
    fontSize: 8.5,
    color: COLORS.muted,
    alignment: 'center',
    margin: [0, 0, 0, 9],
  },
};

export interface PdfMetadata {
  course?: string;
  updated?: string;
}

export function pdfDocumentDefinition(
  notes: Note[],
  assetUrls: ReadonlyMap<string, string>,
  metadata: ReadonlyMap<string, PdfMetadata> = new Map(),
  options: { includeToc?: boolean; language?: string } = {},
): TDocumentDefinitions {
  const content: Content[] = [];
  if (options.includeToc && notes.length > 1) {
    content.push({
      toc: {
        title: {
          text: options.language?.startsWith('fr') ? 'Sommaire' : 'Contents',
          style: 'title',
        },
        textStyle: { color: COLORS.text },
        numberStyle: { color: COLORS.muted },
        outlines: true,
      },
      margin: [0, 0, 0, 12],
    });
  }
  notes.forEach((note, index) => {
    const details = metadata.get(note.id);
    const detailLine = [details?.course, details?.updated].filter(Boolean).join(' · ');
    content.push({
      text: note.title || 'Untitled note',
      style: 'title',
      pageBreak:
        index > 0 || (options.includeToc && notes.length > 1) ? 'before' : undefined,
      tocItem: options.includeToc && notes.length > 1,
      outline: true,
      outlineText: note.title || 'Untitled note',
    });
    if (detailLine) content.push({ text: detailLine, style: 'metadata' });
    content.push(...blocks(note.doc.content, assetUrls));
  });
  return {
    pageSize: 'A4',
    pageMargins: [54, 48, 54, 54],
    content,
    defaultStyle: {
      font: 'Roboto',
      fontSize: 10.5,
      lineHeight: 1.42,
      color: COLORS.text,
    },
    styles,
    info: {
      title: notes.length === 1 ? notes[0]?.title : 'NotaBene notes',
      creator: 'NotaBene',
    },
    footer: (currentPage, pageCount) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'center',
      color: COLORS.muted,
      fontSize: 8,
      margin: [0, 16, 0, 0],
    }),
  };
}

export function notesToPdf(
  notes: Note[],
  assetUrls: ReadonlyMap<string, string>,
  metadata: ReadonlyMap<string, PdfMetadata> = new Map(),
  options: { includeToc?: boolean; language?: string } = {},
): Promise<Blob> {
  return pdfMake
    .createPdf(pdfDocumentDefinition(notes, assetUrls, metadata, options))
    .getBlob();
}
