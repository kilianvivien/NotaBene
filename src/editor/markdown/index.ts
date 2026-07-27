import type { DocNode, NoteDoc } from '@/lib/schema';

type Mark = NonNullable<DocNode['marks']>[number];

function textNode(text: string, marks?: Mark[]): DocNode {
  return marks?.length ? { type: 'text', text, marks } : { type: 'text', text };
}

function parseInline(source: string): DocNode[] {
  const nodes: DocNode[] = [];
  const pattern =
    /(\[\[([^|\]]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|==([^=]+)==|`([^`]+)`|\$([^$\n]+)\$|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) nodes.push(textNode(source.slice(cursor, match.index)));

    if (match[2]) {
      nodes.push({
        type: 'wikiLink',
        attrs: { title: match[2], noteId: match[3] ?? null },
      });
    } else if (match[4] && match[5]) {
      nodes.push(textNode(match[4], [{ type: 'link', attrs: { href: match[5] } }]));
    } else if (match[6]) {
      nodes.push(textNode(match[6], [{ type: 'bold' }]));
    } else if (match[7]) {
      nodes.push(textNode(match[7], [{ type: 'highlight', attrs: { color: null } }]));
    } else if (match[8]) {
      nodes.push(textNode(match[8], [{ type: 'code' }]));
    } else if (match[9]) {
      nodes.push({ type: 'math', attrs: { latex: match[9] } });
    } else {
      nodes.push(textNode(match[10] ?? match[11] ?? '', [{ type: 'italic' }]));
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) nodes.push(textNode(source.slice(cursor)));
  return nodes;
}

function paragraph(text: string): DocNode {
  const content = parseInline(text);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

function tableCell(value: string, type = 'tableCell'): DocNode {
  return { type, content: [paragraph(value)] };
}

function parseQuotedBlock(lines: string[], start: number): [DocNode, number] {
  const marker = lines[start]?.match(/^>\s*\[!(INFO|WARN|IMPORTANT|TOGGLE)(?:\s+([^\]]+))?\]\s*$/i);
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
    body.push((lines[index] ?? '').replace(/^>\s?/, ''));
    index += 1;
  }

  if (marker) {
    const nested = markdownToDoc(body.join('\n')).content;
    if (marker[1]?.toUpperCase() === 'TOGGLE') {
      return [
        {
          type: 'toggle',
          attrs: { summary: marker[2] ?? 'Details', open: false },
          content: nested.length ? nested : [paragraph('')],
        },
        index,
      ];
    }
    return [
      {
        type: 'callout',
        attrs: { kind: marker[1]?.toLowerCase() ?? 'info' },
        content: nested.length ? nested : [paragraph('')],
      },
      index,
    ];
  }

  const content = markdownToDoc(
    [lines[start]?.replace(/^>\s?/, '') ?? '', ...body].join('\n'),
  ).content;
  return [{ type: 'blockquote', content }, index];
}

/** Parse the loss-aware Markdown dialect used by exports and MCP tools. */
export function markdownToDoc(markdown: string): NoteDoc {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const content: DocNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      if (fence[1] === 'notabene-drawing' || fence[1] === 'notabene-mindmap') {
        try {
          const payload = JSON.parse(body.join('\n')) as Record<string, unknown>;
          content.push({
            type: fence[1] === 'notabene-drawing' ? 'drawing' : 'mindMap',
            attrs: payload,
          });
        } catch {
          content.push({
            type: 'codeBlock',
            attrs: { language: fence[1] || null },
            content: [textNode(body.join('\n'))],
          });
        }
      } else {
        content.push({
          type: 'codeBlock',
          attrs: { language: fence[1] || null },
          content: body.length ? [textNode(body.join('\n'))] : undefined,
        });
      }
      continue;
    }

    if (/^\$\$\s*$/.test(line)) {
      const latex: string[] = [];
      index += 1;
      while (index < lines.length && !/^\$\$\s*$/.test(lines[index] ?? '')) {
        latex.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      content.push({ type: 'mathBlock', attrs: { latex: latex.join('\n') } });
      continue;
    }

    const assetImage = line.match(/^!\[([^\]]*)\]\(asset:([^)]+)\)\s*$/);
    if (assetImage) {
      content.push({
        type: 'image',
        attrs: {
          assetId: assetImage[2] ?? '',
          alt: assetImage[1] ?? '',
          caption: assetImage[1] ?? '',
          align: 'center',
          width: 640,
        },
      });
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1]?.length ?? 1 },
        content: parseInline(heading[2] ?? ''),
      });
      index += 1;
      continue;
    }

    if (/^(?:---+|\*\*\*+)\s*$/.test(line)) {
      content.push({ type: 'horizontalRule' });
      index += 1;
      continue;
    }

    if (line.startsWith('>')) {
      const [node, next] = parseQuotedBlock(lines, index);
      content.push(node);
      index = next;
      continue;
    }

    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      const items: DocNode[] = [];
      while (index < lines.length) {
        const candidate = (lines[index] ?? '').match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
        if (!candidate) break;
        items.push({
          type: 'taskItem',
          attrs: { checked: candidate[1]?.toLowerCase() === 'x' },
          content: [paragraph(candidate[2] ?? '')],
        });
        index += 1;
      }
      content.push({ type: 'taskList', content: items });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const type = ordered ? 'orderedList' : 'bulletList';
      const items: DocNode[] = [];
      const start = ordered ? Number(ordered[1]) : undefined;
      while (index < lines.length) {
        const candidate = ordered
          ? (lines[index] ?? '').match(/^\s*\d+[.)]\s+(.+)$/)
          : (lines[index] ?? '').match(/^\s*[-*+]\s+(.+)$/);
        if (!candidate) break;
        items.push({
          type: 'listItem',
          content: [paragraph(candidate[ordered ? 1 : 1] ?? '')],
        });
        index += 1;
      }
      content.push({ type, attrs: ordered ? { start } : undefined, content: items });
      continue;
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      isTableDivider(lines[index + 1] ?? '')
    ) {
      const header = cells(line);
      const rows: DocNode[] = [
        { type: 'tableRow', content: header.map((value) => tableCell(value, 'tableHeader')) },
      ];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        rows.push({
          type: 'tableRow',
          content: cells(lines[index] ?? '').map((value) => tableCell(value)),
        });
        index += 1;
      }
      content.push({ type: 'table', content: rows });
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !/^(#{1,6})\s+|^```|^\$\$\s*$|^>|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(
        lines[index] ?? '',
      )
    ) {
      paragraphLines.push(lines[index] ?? '');
      index += 1;
    }
    content.push(paragraph(paragraphLines.join(' ')));
  }

  return { type: 'doc', content };
}

function inlineToMarkdown(node: DocNode): string {
  if (node.type === 'wikiLink') {
    const title = String(node.attrs?.title ?? '');
    const id = node.attrs?.noteId;
    return id ? `[[${title}|${String(id)}]]` : `[[${title}]]`;
  }
  if (node.type === 'math') return `$${String(node.attrs?.latex ?? '')}$`;
  if (node.type === 'image') {
    const caption = String(node.attrs?.caption ?? node.attrs?.alt ?? '');
    return `![${caption}](asset:${String(node.attrs?.assetId ?? '')})`;
  }
  if (node.type !== 'text') return (node.content ?? []).map(inlineToMarkdown).join('');

  let text = node.text ?? '';
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        text = `**${text}**`;
        break;
      case 'italic':
        text = `*${text}*`;
        break;
      case 'strike':
        text = `~~${text}~~`;
        break;
      case 'code':
        text = `\`${text}\``;
        break;
      case 'highlight':
        text = `==${text}==`;
        break;
      case 'link':
        text = `[${text}](${String(mark.attrs?.href ?? '')})`;
        break;
      default:
        break;
    }
  }
  return text;
}

function blockToMarkdown(node: DocNode): string {
  const inline = () => (node.content ?? []).map(inlineToMarkdown).join('');
  const nested = () => (node.content ?? []).map(blockToMarkdown).join('\n\n');

  switch (node.type) {
    case 'paragraph':
      return inline();
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inline()}`;
    case 'horizontalRule':
      return '---';
    case 'blockquote':
      return nested()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'callout': {
      const kind = String(node.attrs?.kind ?? 'info').toUpperCase();
      return `> [!${kind}]\n${nested()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}`;
    }
    case 'toggle':
      return `> [!TOGGLE ${String(node.attrs?.summary ?? 'Details')}]\n${nested()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}`;
    case 'codeBlock':
      return `\`\`\`${String(node.attrs?.language ?? '')}\n${(node.content ?? [])
        .map((child) => child.text ?? '')
        .join('')}\n\`\`\``;
    case 'mathBlock':
      return `$$\n${String(node.attrs?.latex ?? '')}\n$$`;
    case 'bulletList':
      return (node.content ?? [])
        .map((item) => `- ${(item.content ?? []).map(blockToMarkdown).join(' ')}`)
        .join('\n');
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? [])
        .map(
          (item, index) =>
            `${start + index}. ${(item.content ?? []).map(blockToMarkdown).join(' ')}`,
        )
        .join('\n');
    }
    case 'taskList':
      return (node.content ?? [])
        .map(
          (item) =>
            `- [${item.attrs?.checked ? 'x' : ' '}] ${(item.content ?? [])
              .map(blockToMarkdown)
              .join(' ')}`,
        )
        .join('\n');
    case 'table': {
      const rows = node.content ?? [];
      const values = rows.map((row) =>
        (row.content ?? []).map((cell) => (cell.content ?? []).map(blockToMarkdown).join(' ')),
      );
      if (!values.length) return '';
      const width = values[0]?.length ?? 0;
      return [
        `| ${(values[0] ?? []).join(' | ')} |`,
        `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
        ...values.slice(1).map((row) => `| ${row.join(' | ')} |`),
      ].join('\n');
    }
    case 'drawing':
      return `\`\`\`notabene-drawing\n${JSON.stringify(node.attrs ?? {})}\n\`\`\``;
    case 'mindMap':
      return `\`\`\`notabene-mindmap\n${JSON.stringify(node.attrs ?? {})}\n\`\`\``;
    case 'image':
    case 'wikiLink':
    case 'math':
      return inlineToMarkdown(node);
    default:
      return nested();
  }
}

export function docToMarkdown(doc: NoteDoc): string {
  return doc.content.map(blockToMarkdown).filter(Boolean).join('\n\n').trim();
}
