import type { DocNode, NoteDoc } from '@/lib/schema';

type Mark = NonNullable<DocNode['marks']>[number];
type NoteDefinition = { note: string; kind: 'footnote' | 'endnote' };

export interface MarkdownParseOptions {
  /**
   * How to read `[[a|b]]`. An explicit option, never a guess: a note id is a
   * bare 12-character nanoid, so a one-word Obsidian alias is indistinguishable
   * from one.
   *
   * - `'notabene'` (default): `b` is the note id — what `docToMarkdown`
   *   writes, so an export round-trips.
   * - `'obsidian'`: `b` is a display alias, a folder prefix and a `#heading`
   *   are dropped from `a`, and no id is claimed unless `resolveWikiLink`
   *   supplies one.
   */
  wikiLinks?: 'notabene' | 'obsidian';
  /**
   * Obsidian dialect only: turn a link's target — `Physics/Week 4`, heading
   * already removed — into the note it means. An importer passes one that
   * knows the whole batch, which is how a link to a note written in the same
   * import gets its id before either exists. Without it the target's last
   * path segment becomes the title and resolution is left to the title.
   */
  resolveWikiLink?(target: string): { title: string; noteId: string | null };
}

type ParseOptions = MarkdownParseOptions & {
  definitions: ReadonlyMap<string, NoteDefinition>;
};

/** `Physics/Week 4.md` → `Week 4`. */
function wikiBasename(target: string): string {
  return (target.split('/').pop() ?? target).replace(/\.md$/i, '').trim();
}

function obsidianWikiLink(raw: string, alias: string | undefined, options: ParseOptions): DocNode {
  const hash = raw.indexOf('#');
  const target = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  const label = alias?.trim() || null;
  // `[[#Damping]]` points inside the note it is written in. There is no such
  // link in NotaBene, and a link to a note titled "" would be worse than text.
  if (!target) return textNode(label ?? raw.slice(hash + 1).replace(/^\^/, '').trim());
  const resolved = options.resolveWikiLink?.(target) ?? {
    title: wikiBasename(target),
    noteId: null,
  };
  const attrs: Record<string, unknown> = { title: resolved.title, noteId: resolved.noteId };
  if (label && label !== resolved.title) attrs.label = label;
  return { type: 'wikiLink', attrs };
}

function textNode(text: string, marks?: Mark[]): DocNode {
  return marks?.length ? { type: 'text', text, marks } : { type: 'text', text };
}

function parseInline(source: string, options: ParseOptions): DocNode[] {
  const { definitions } = options;
  const nodes: DocNode[] = [];
  const pattern =
    /(\[\[([^|\]]+)(?:\|([^\]]+))?\]\]|\[task:([^|\]]+)\|([^\]]*)\]|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|==([^=]+)==|`([^`]+)`|\$([^$\n]+)\$|\*([^*\n]+)\*|_([^_\n]+)_|\[\^([^\]]+)\])/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) nodes.push(textNode(source.slice(cursor, match.index)));

    if (match[2]) {
      nodes.push(
        options.wikiLinks === 'obsidian'
          ? obsidianWikiLink(match[2], match[3], options)
          : { type: 'wikiLink', attrs: { title: match[2], noteId: match[3] ?? null } },
      );
    } else if (match[4]) {
      nodes.push({
        type: 'taskRef',
        attrs: { taskId: match[4], label: match[5] ?? '' },
      });
    } else if (match[6] && match[7]) {
      nodes.push(textNode(match[6], [{ type: 'link', attrs: { href: match[7] } }]));
    } else if (match[8]) {
      nodes.push(textNode(match[8], [{ type: 'bold' }]));
    } else if (match[9]) {
      nodes.push(textNode(match[9], [{ type: 'highlight', attrs: { color: null } }]));
    } else if (match[10]) {
      nodes.push(textNode(match[10], [{ type: 'code' }]));
    } else if (match[11]) {
      nodes.push({ type: 'math', attrs: { latex: match[11] } });
    } else if (match[14]) {
      const definition = definitions.get(match[14]);
      if (definition) {
        nodes.push({
          type: 'footnote',
          attrs: { id: match[14], kind: definition.kind, note: definition.note },
        });
      } else {
        nodes.push(textNode(match[0]));
      }
    } else {
      nodes.push(textNode(match[12] ?? match[13] ?? '', [{ type: 'italic' }]));
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) nodes.push(textNode(source.slice(cursor)));
  return nodes;
}

function paragraph(text: string, options: ParseOptions): DocNode {
  const content = parseInline(text, options);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

/**
 * The `| --- | --- |` line under a table's header.
 *
 * The first alternative is the fully-piped form, which is the only way a
 * *single-column* table can be written — a spreadsheet with one column is an
 * ordinary import. It requires both outer pipes on purpose: a bare `---` is a
 * horizontal rule, and must not turn the paragraph above it into a table
 * just because that paragraph happened to contain a pipe.
 */
function isTableDivider(line: string): boolean {
  return (
    /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line) ||
    /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line)
  );
}

/**
 * A table row's cells.
 *
 * Splits on *unescaped* pipes: a pipe is the one character a cell cannot
 * hold literally, so `\|` carries one through. Without this a pipe in the
 * text silently gained the row a column — which document import made
 * routine, since a spreadsheet cell may hold anything.
 */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
}

function tableCell(value: string, type: string, options: ParseOptions): DocNode {
  return { type, content: [paragraph(value, options)] };
}

function parseQuotedBlock(
  lines: string[],
  start: number,
  options: ParseOptions,
): [DocNode, number] {
  const marker = lines[start]?.match(
    /^>\s*\[!(INFO|WARN|IMPORTANT|TOGGLE)(?:\s+([^\]]+))?\]\s*$/i,
  );
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
    body.push((lines[index] ?? '').replace(/^>\s?/, ''));
    index += 1;
  }

  if (marker) {
    const nested = parseMarkdown(body.join('\n'), options).content;
    if (marker[1]?.toUpperCase() === 'TOGGLE') {
      return [
        {
          type: 'toggle',
          attrs: { summary: marker[2] ?? 'Details', open: false },
          content: nested.length ? nested : [paragraph('', options)],
        },
        index,
      ];
    }
    return [
      {
        type: 'callout',
        attrs: { kind: marker[1]?.toLowerCase() ?? 'info' },
        content: nested.length ? nested : [paragraph('', options)],
      },
      index,
    ];
  }

  const content = parseMarkdown(
    [lines[start]?.replace(/^>\s?/, '') ?? '', ...body].join('\n'),
    options,
  ).content;
  return [{ type: 'blockquote', content }, index];
}

/** Parse the loss-aware Markdown dialect used by exports and MCP tools. */
export function markdownToDoc(markdown: string, options: MarkdownParseOptions = {}): NoteDoc {
  return parseMarkdown(markdown, { ...options, definitions: new Map() });
}

function parseMarkdown(markdown: string, inherited: ParseOptions): NoteDoc {
  const definitions = new Map(inherited.definitions);
  const options: ParseOptions = { ...inherited, definitions };
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => {
      const definition = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
      if (!definition) return true;
      const label = definition[1] ?? '';
      definitions.set(label, {
        note: definition[2] ?? '',
        kind: label.startsWith('en-') ? 'endnote' : 'footnote',
      });
      return false;
    });
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
        content: parseInline(heading[2] ?? '', options),
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
      const [node, next] = parseQuotedBlock(lines, index, options);
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
          content: [paragraph(candidate[2] ?? '', options)],
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
          content: [paragraph(candidate[ordered ? 1 : 1] ?? '', options)],
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
        {
          type: 'tableRow',
          content: header.map((value) => tableCell(value, 'tableHeader', options)),
        },
      ];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        rows.push({
          type: 'tableRow',
          content: cells(lines[index] ?? '').map((value) =>
            tableCell(value, 'tableCell', options),
          ),
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
    content.push(paragraph(paragraphLines.join(' '), options));
  }

  return { type: 'doc', content };
}

function inlineToMarkdown(
  node: DocNode,
  noteLabels: ReadonlyMap<DocNode, string>,
): string {
  if (node.type === 'wikiLink') {
    const title = String(node.attrs?.title ?? '');
    const id = node.attrs?.noteId;
    return id ? `[[${title}|${String(id)}]]` : `[[${title}]]`;
  }
  // Round-trips through `TASK_REF` below, so a note exported to Markdown and
  // imported again keeps its chips rather than degrading to plain text.
  if (node.type === 'taskRef') {
    const label = String(node.attrs?.label ?? '');
    const id = node.attrs?.taskId;
    return id ? `[task:${String(id)}|${label}]` : `☐ ${label}`;
  }
  if (node.type === 'footnote') return `[^${noteLabels.get(node) ?? 'fn-1'}]`;
  if (node.type === 'math') return `$${String(node.attrs?.latex ?? '')}$`;
  if (node.type === 'image') {
    const caption = String(node.attrs?.caption ?? node.attrs?.alt ?? '');
    return `![${caption}](asset:${String(node.attrs?.assetId ?? '')})`;
  }
  if (node.type !== 'text')
    return (node.content ?? [])
      .map((child) => inlineToMarkdown(child, noteLabels))
      .join('');

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

function blockToMarkdown(
  node: DocNode,
  noteLabels: ReadonlyMap<DocNode, string>,
): string {
  const inline = () =>
    (node.content ?? []).map((child) => inlineToMarkdown(child, noteLabels)).join('');
  const nested = () =>
    (node.content ?? []).map((child) => blockToMarkdown(child, noteLabels)).join('\n\n');

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
        .map(
          (item) =>
            `- ${(item.content ?? []).map((child) => blockToMarkdown(child, noteLabels)).join(' ')}`,
        )
        .join('\n');
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? [])
        .map(
          (item, index) =>
            `${start + index}. ${(item.content ?? []).map((child) => blockToMarkdown(child, noteLabels)).join(' ')}`,
        )
        .join('\n');
    }
    case 'taskList':
      return (node.content ?? [])
        .map(
          (item) =>
            `- [${item.attrs?.checked ? 'x' : ' '}] ${(item.content ?? [])
              .map((child) => blockToMarkdown(child, noteLabels))
              .join(' ')}`,
        )
        .join('\n');
    case 'table': {
      const rows = node.content ?? [];
      const values = rows.map((row) =>
        (row.content ?? []).map((cell) =>
          (cell.content ?? [])
            .map((child) => blockToMarkdown(child, noteLabels))
            .join(' ')
            // Paired with `cells()`, which splits on unescaped pipes only.
            .replaceAll('|', '\\|'),
        ),
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
    case 'taskRef':
    case 'math':
    case 'footnote':
      return inlineToMarkdown(node, noteLabels);
    default:
      return nested();
  }
}

export function docToMarkdown(doc: NoteDoc): string {
  const notes: DocNode[] = [];
  const walk = (node: DocNode) => {
    if (node.type === 'footnote') notes.push(node);
    for (const child of node.content ?? []) walk(child);
  };
  for (const node of doc.content) walk(node);
  const labels = new Map<DocNode, string>();
  let footnote = 0;
  let endnote = 0;
  for (const node of notes) {
    const kind = node.attrs?.kind === 'endnote' ? 'endnote' : 'footnote';
    const number = kind === 'endnote' ? ++endnote : ++footnote;
    labels.set(node, `${kind === 'endnote' ? 'en' : 'fn'}-${number}`);
  }
  const body = doc.content
    .map((node) => blockToMarkdown(node, labels))
    .filter(Boolean)
    .join('\n\n')
    .trim();
  const definitions = notes.map(
    (node) =>
      `[^${labels.get(node)}]: ${String(node.attrs?.note ?? '').replaceAll('\n', ' ')}`,
  );
  return [body, definitions.join('\n')].filter(Boolean).join('\n\n');
}
