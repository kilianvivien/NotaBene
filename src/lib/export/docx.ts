import {
  AlignmentType,
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
  TableRow,
  TextRun,
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
  const run = new TextRun(options);
  return link
    ? [
        new ExternalHyperlink({
          link: String(link.attrs?.href ?? ''),
          children: [run],
        }),
      ]
    : [run];
}

async function imageParagraph(
  node: DocNode,
  assetData: ReadonlyMap<string, { bytes: Uint8Array; mime: string }>,
): Promise<Paragraph | null> {
  if (node.type === 'drawing' && typeof node.attrs?.svg === 'string') {
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
): Promise<FileChild[]> {
  const result: FileChild[] = [];
  for (const node of nodes) {
    const image = await imageParagraph(node, assetData);
    if (image) {
      result.push(image);
      continue;
    }
    switch (node.type) {
      case 'paragraph':
        result.push(new Paragraph({ children: (node.content ?? []).flatMap(inlineRuns) }));
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
          result.push(
            new Paragraph({
              text:
                node.type === 'taskList'
                  ? `${item.attrs?.checked ? '☑' : '☐'} ${nodeText(item)}`
                  : nodeText(item),
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
      case 'callout':
      case 'toggle':
        result.push(
          new Paragraph({
            text: `${node.type === 'toggle' ? `${String(node.attrs?.summary ?? 'Details')}: ` : ''}${nodeText(node)}`,
            indent: { left: 360 },
          }),
        );
        break;
      case 'codeBlock':
        result.push(
          new Paragraph({
            children: [new TextRun({ text: nodeText(node), font: 'SF Mono' })],
            shading: { fill: 'F3F1ED' },
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
            rows: (node.content ?? []).map(
              (row) =>
                new TableRow({
                  children: (row.content ?? []).map(
                    (cell) =>
                      new TableCell({
                        children: [new Paragraph(nodeText(cell))],
                      }),
                  ),
                }),
            ),
          }),
        );
        break;
      case 'horizontalRule':
        result.push(new Paragraph('────────────────────────'));
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
    sections: [{ children }],
  });
  return Packer.toBlob(document);
}
