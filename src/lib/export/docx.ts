import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Math as DocxMath,
  MathRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type FileChild,
  type ParagraphChild,
} from 'docx';
import type { DocNode, Note } from '@/lib/schema';

const TRANSPARENT_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw7WAAAAAElFTkSuQmCC',
  ),
  (character) => character.charCodeAt(0),
);

function svgDataUri(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function nodeText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'math' || node.type === 'mathBlock')
    return String(node.attrs?.latex ?? '');
  return (node.content ?? []).map(nodeText).join('');
}

function inlineRuns(node: DocNode): ParagraphChild[] {
  if (node.type === 'wikiLink') return [new TextRun(String(node.attrs?.title ?? ''))];
  if (node.type === 'math') {
    return [new DocxMath({ children: [new MathRun(String(node.attrs?.latex ?? ''))] })];
  }
  if (node.type !== 'text') return (node.content ?? []).flatMap(inlineRuns);
  const options = {
    text: node.text ?? '',
    bold: node.marks?.some((mark) => mark.type === 'bold'),
    italics: node.marks?.some((mark) => mark.type === 'italic'),
    strike: node.marks?.some((mark) => mark.type === 'strike'),
    underline: node.marks?.some((mark) => mark.type === 'underline') ? {} : undefined,
    highlight: node.marks?.some((mark) => mark.type === 'highlight')
      ? ('yellow' as const)
      : undefined,
    font: node.marks?.some((mark) => mark.type === 'code') ? 'SF Mono' : undefined,
  };
  const link = node.marks?.find((mark) => mark.type === 'link');
  const href = String(link?.attrs?.href ?? '');
  return link && /^(https?:|mailto:)/i.test(href)
    ? [
        new ExternalHyperlink({
          link: href,
          children: [
            new TextRun({
              ...options,
              color: '2768AD',
              underline: {},
            }),
          ],
        }),
      ]
    : [new TextRun(options)];
}

function paragraphRuns(node: DocNode): ParagraphChild[] {
  return (node.content ?? []).flatMap((child) =>
    child.type === 'paragraph'
      ? (child.content ?? []).flatMap(inlineRuns)
      : inlineRuns(child),
  );
}

const tableBorders = {
  top: { style: BorderStyle.SINGLE, color: 'D1CCC4', size: 4 },
  bottom: { style: BorderStyle.SINGLE, color: 'D1CCC4', size: 4 },
  left: { style: BorderStyle.SINGLE, color: 'D1CCC4', size: 4 },
  right: { style: BorderStyle.SINGLE, color: 'D1CCC4', size: 4 },
  insideHorizontal: { style: BorderStyle.SINGLE, color: 'D1CCC4', size: 4 },
  insideVertical: { style: BorderStyle.SINGLE, color: 'D1CCC4', size: 4 },
};

const noBorder = { style: BorderStyle.NIL, color: 'FFFFFF', size: 0 };

async function imageParagraph(
  node: DocNode,
  assetData: ReadonlyMap<string, { bytes: Uint8Array; mime: string }>,
): Promise<Paragraph | null> {
  if (
    (node.type === 'drawing' || node.type === 'mindMap') &&
    typeof node.attrs?.svg === 'string' &&
    node.attrs.svg
  ) {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new ImageRun({
          type: 'svg',
          data: svgDataUri(node.attrs.svg),
          fallback: { type: 'png', data: TRANSPARENT_PNG },
          transformation: { width: 620, height: 360 },
        }),
      ],
    });
  }
  if (node.type !== 'image') return null;
  const asset = assetData.get(String(node.attrs?.assetId ?? ''));
  if (!asset) return new Paragraph(`[${String(node.attrs?.caption ?? 'Image')}]`);
  const type =
    asset.mime === 'image/png'
      ? 'png'
      : asset.mime === 'image/gif'
        ? 'gif'
        : asset.mime === 'image/bmp'
          ? 'bmp'
          : 'jpg';
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new ImageRun({
        type,
        data: asset.bytes,
        transformation: {
          width: Math.min(620, Number(node.attrs?.width ?? 620)),
          height: Math.min(440, Number(node.attrs?.height ?? 360)),
        },
      }),
    ],
  });
}

async function blocks(
  nodes: DocNode[],
  assetData: ReadonlyMap<string, { bytes: Uint8Array; mime: string }>,
): Promise<Array<Paragraph | Table>> {
  const result: Array<Paragraph | Table> = [];
  for (const node of nodes) {
    const image = await imageParagraph(node, assetData);
    if (image) {
      result.push(image);
      continue;
    }
    switch (node.type) {
      case 'paragraph':
        result.push(
          new Paragraph({ children: (node.content ?? []).flatMap(inlineRuns) }),
        );
        break;
      case 'heading': {
        const levels = [
          HeadingLevel.HEADING_1,
          HeadingLevel.HEADING_2,
          HeadingLevel.HEADING_3,
          HeadingLevel.HEADING_4,
          HeadingLevel.HEADING_5,
          HeadingLevel.HEADING_6,
        ];
        result.push(
          new Paragraph({
            heading: levels[Math.min(5, Math.max(0, Number(node.attrs?.level ?? 1) - 1))],
            children: (node.content ?? []).flatMap(inlineRuns),
          }),
        );
        break;
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        for (const [index, item] of (node.content ?? []).entries()) {
          const prefix =
            node.type === 'taskList'
              ? [
                  new TextRun({
                    text: item.attrs?.checked ? '☑  ' : '☐  ',
                    color: 'A8602D',
                  }),
                ]
              : [];
          result.push(
            new Paragraph({
              children: [...prefix, ...paragraphRuns(item)],
              bullet: node.type === 'bulletList' ? { level: 0 } : undefined,
              numbering:
                node.type === 'orderedList'
                  ? { reference: 'notabene-numbering', level: 0 }
                  : undefined,
              ...(node.type === 'orderedList' && index === 0
                ? { contextualSpacing: true }
                : {}),
            }),
          );
        }
        break;
      case 'blockquote':
        result.push(
          new Paragraph({
            children: paragraphRuns(node),
            indent: { left: 360 },
            border: {
              left: {
                style: BorderStyle.SINGLE,
                color: 'AAA59D',
                size: 14,
                space: 8,
              },
            },
            spacing: { before: 100, after: 160 },
          }),
        );
        break;
      case 'callout': {
        const kind = String(node.attrs?.kind ?? 'info');
        const accent = kind === 'important' ? '9D4D67' : 'A8602D';
        const fill = kind === 'important' ? 'FAEFF3' : 'F8F0E9';
        result.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            borders: {
              top: noBorder,
              bottom: noBorder,
              left: { style: BorderStyle.SINGLE, color: accent, size: 22 },
              right: noBorder,
              insideHorizontal: noBorder,
              insideVertical: noBorder,
            },
            rows: [
              new TableRow({
                cantSplit: true,
                children: [
                  new TableCell({
                    shading: { fill },
                    margins: { top: 150, bottom: 100, left: 190, right: 190 },
                    borders: {
                      top: noBorder,
                      bottom: noBorder,
                      left: { style: BorderStyle.SINGLE, color: accent, size: 22 },
                      right: noBorder,
                    },
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: kind === 'warn' ? 'WARNING' : kind.toUpperCase(),
                            bold: true,
                            size: 16,
                            color: accent,
                            characterSpacing: 10,
                          }),
                        ],
                        spacing: { after: 80 },
                      }),
                      ...(await blocks(node.content ?? [], assetData)),
                    ],
                  }),
                ],
              }),
            ],
          }),
          new Paragraph({
            children: [new TextRun({ text: '', size: 2 })],
            spacing: { after: 90, line: 20 },
          }),
        );
        break;
      }
      case 'toggle':
        result.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${String(node.attrs?.summary ?? 'Details')}: `,
                bold: true,
                color: 'A8602D',
              }),
              ...paragraphRuns(node),
            ],
            indent: { left: 260 },
            spacing: { before: 100, after: 120 },
          }),
        );
        break;
      case 'codeBlock':
        result.push(
          new Paragraph({
            children: [new TextRun({ text: nodeText(node), font: 'SF Mono' })],
            shading: { fill: 'F3F1ED' },
            indent: { left: 180, right: 180 },
            spacing: { before: 100, after: 180 },
          }),
        );
        break;
      case 'mathBlock':
        result.push(
          new Paragraph({
            children: [
              new DocxMath({
                children: [new MathRun(String(node.attrs?.latex ?? ''))],
              }),
            ],
          }),
        );
        break;
      case 'table':
        result.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            borders: tableBorders,
            rows: (node.content ?? []).map(
              (row) =>
                new TableRow({
                  children: (row.content ?? []).map(
                    (cell) =>
                      new TableCell({
                        shading:
                          cell.type === 'tableHeader' ? { fill: 'F3F1ED' } : undefined,
                        margins: { top: 90, bottom: 90, left: 110, right: 110 },
                        children: [
                          new Paragraph({
                            children: paragraphRuns(cell),
                            run: { bold: cell.type === 'tableHeader' },
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          }),
        );
        break;
      case 'horizontalRule':
        result.push(
          new Paragraph({
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                color: 'CBC6BE',
                size: 5,
              },
            },
            spacing: { before: 100, after: 180 },
          }),
        );
        break;
      default:
        if (nodeText(node)) result.push(new Paragraph(nodeText(node)));
    }
  }
  return result;
}

export async function notesToDocx(
  notes: Note[],
  assetData: ReadonlyMap<string, { bytes: Uint8Array; mime: string }>,
): Promise<Blob> {
  const children: FileChild[] = [];
  for (const note of notes) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        text: note.title || 'Untitled note',
        pageBreakBefore: children.length > 0,
      }),
      ...(await blocks(note.doc.content, assetData)),
    );
  }
  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 22, color: '24221F' },
          paragraph: { spacing: { after: 130, line: 330 } },
        },
        title: {
          run: { font: 'Arial', size: 50, bold: true, color: '24221F' },
          paragraph: { spacing: { after: 180 }, keepNext: true },
        },
        heading1: {
          run: { font: 'Arial', size: 38, bold: true, color: '24221F' },
          paragraph: { spacing: { before: 280, after: 120 }, keepNext: true },
        },
        heading2: {
          run: { font: 'Arial', size: 30, bold: true, color: '24221F' },
          paragraph: { spacing: { before: 240, after: 100 }, keepNext: true },
        },
        heading3: {
          run: { font: 'Arial', size: 25, bold: true, color: 'A8602D' },
          paragraph: { spacing: { before: 210, after: 90 }, keepNext: true },
        },
        heading4: {
          run: { font: 'Arial', size: 23, bold: true, color: '24221F' },
          paragraph: { spacing: { before: 190, after: 80 }, keepNext: true },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: 'notabene-numbering',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 960, right: 1080, bottom: 1080, left: 1080 } },
        },
        children,
      },
    ],
  });
  return Packer.toBlob(document);
}
