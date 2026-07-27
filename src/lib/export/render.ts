import katex from 'katex';
import type { DocNode, NoteDoc } from '@/lib/schema';

export const EXPORT_STYLES = `
:root{color:#24221f;background:#fff;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{max-width:760px;margin:0 auto;padding:48px 54px}h1,h2,h3,h4,h5,h6{line-height:1.2;margin:1.4em 0 .55em}
h1{font-size:2.1rem}h2{font-size:1.55rem}h3{font-size:1.25rem}p{margin:.65em 0}a{color:#2768ad}
blockquote,.callout,details,pre,table,figure{break-inside:avoid}blockquote{border-left:3px solid #bbb;margin:1em 0;padding:.2em 1em;color:#555}
.callout{border:1px solid #c8c4bd;border-left:4px solid #c17a47;border-radius:8px;padding:.8em 1em;margin:1em 0}
.callout-label{font-size:.75rem;font-weight:700;text-transform:uppercase;color:#725037}pre{background:#f3f1ed;border-radius:7px;padding:1em;overflow:auto}
code{font-family:"SFMono-Regular",Consolas,monospace;background:#f3f1ed;border-radius:4px;padding:.08em .3em}pre code{padding:0}
table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid #ccc;padding:.45em .6em;text-align:left}
img,svg{display:block;max-width:100%;height:auto;margin:1em auto}figcaption{text-align:center;color:#777;font-size:.85rem}
.note{break-after:page}.note:last-child{break-after:auto}.metadata{color:#777;font-size:.85rem}.toc a{text-decoration:none}
@page{margin:18mm 16mm 20mm}@media print{body{max-width:none;padding:0}.note{break-after:page}}
`;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inlineHtml(node: DocNode, assetUrls: ReadonlyMap<string, string>): string {
  if (node.type === 'wikiLink') {
    return `<span class="wiki-link">${escapeHtml(node.attrs?.title)}</span>`;
  }
  if (node.type === 'math') {
    try {
      return katex.renderToString(String(node.attrs?.latex ?? ''), {
        throwOnError: false,
      });
    } catch {
      return `<code>${escapeHtml(node.attrs?.latex)}</code>`;
    }
  }
  if (node.type === 'image') return blockHtml(node, assetUrls);
  if (node.type !== 'text') {
    return (node.content ?? []).map((child) => inlineHtml(child, assetUrls)).join('');
  }

  let value = escapeHtml(node.text);
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        value = `<strong>${value}</strong>`;
        break;
      case 'italic':
        value = `<em>${value}</em>`;
        break;
      case 'strike':
        value = `<s>${value}</s>`;
        break;
      case 'underline':
        value = `<u>${value}</u>`;
        break;
      case 'highlight':
        value = `<mark>${value}</mark>`;
        break;
      case 'code':
        value = `<code>${value}</code>`;
        break;
      case 'link':
        value = `<a href="${escapeHtml(mark.attrs?.href)}">${value}</a>`;
        break;
      default:
        break;
    }
  }
  return value;
}

function childrenHtml(node: DocNode, assetUrls: ReadonlyMap<string, string>): string {
  return (node.content ?? []).map((child) => blockHtml(child, assetUrls)).join('');
}

function blockHtml(node: DocNode, assetUrls: ReadonlyMap<string, string>): string {
  const inline = () =>
    (node.content ?? []).map((child) => inlineHtml(child, assetUrls)).join('');
  switch (node.type) {
    case 'paragraph':
      return `<p>${inline() || '<br>'}</p>`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `<h${level}>${inline()}</h${level}>`;
    }
    case 'horizontalRule':
      return '<hr>';
    case 'blockquote':
      return `<blockquote>${childrenHtml(node, assetUrls)}</blockquote>`;
    case 'callout':
      return `<aside class="callout"><div class="callout-label">${escapeHtml(node.attrs?.kind ?? 'info')}</div>${childrenHtml(node, assetUrls)}</aside>`;
    case 'toggle':
      return `<details open><summary>${escapeHtml(node.attrs?.summary ?? 'Details')}</summary>${childrenHtml(node, assetUrls)}</details>`;
    case 'codeBlock':
      return `<pre><code class="language-${escapeHtml(node.attrs?.language)}">${escapeHtml((node.content ?? []).map((child) => child.text ?? '').join(''))}</code></pre>`;
    case 'mathBlock': {
      try {
        return katex.renderToString(String(node.attrs?.latex ?? ''), {
          displayMode: true,
          throwOnError: false,
        });
      } catch {
        return `<pre>${escapeHtml(node.attrs?.latex)}</pre>`;
      }
    }
    case 'bulletList':
      return `<ul>${(node.content ?? []).map((item) => `<li>${childrenHtml(item, assetUrls)}</li>`).join('')}</ul>`;
    case 'orderedList':
      return `<ol start="${Number(node.attrs?.start ?? 1)}">${(node.content ?? []).map((item) => `<li>${childrenHtml(item, assetUrls)}</li>`).join('')}</ol>`;
    case 'taskList':
      return `<ul class="tasks">${(node.content ?? []).map((item) => `<li>${item.attrs?.checked ? '☑' : '☐'} ${childrenHtml(item, assetUrls)}</li>`).join('')}</ul>`;
    case 'listItem':
    case 'taskItem':
    case 'tableCell':
    case 'tableHeader':
      return childrenHtml(node, assetUrls);
    case 'table':
      return `<table>${(node.content ?? [])
        .map(
          (row) =>
            `<tr>${(row.content ?? [])
              .map((cell) => {
                const tag = cell.type === 'tableHeader' ? 'th' : 'td';
                return `<${tag}>${childrenHtml(cell, assetUrls)}</${tag}>`;
              })
              .join('')}</tr>`,
        )
        .join('')}</table>`;
    case 'image': {
      const id = String(node.attrs?.assetId ?? '');
      const source = assetUrls.get(id);
      if (!source) return `<p>[${escapeHtml(node.attrs?.caption ?? 'Image')}]</p>`;
      return `<figure><img src="${escapeHtml(source)}" alt="${escapeHtml(node.attrs?.alt ?? node.attrs?.caption)}"><figcaption>${escapeHtml(node.attrs?.caption)}</figcaption></figure>`;
    }
    case 'drawing':
    case 'mindMap': {
      const fallback = node.type === 'mindMap' ? 'Mind map' : 'Drawing';
      const svg = typeof node.attrs?.svg === 'string' ? node.attrs.svg : '';
      return svg
        ? `<figure>${svg}<figcaption>${escapeHtml(node.attrs?.title ?? fallback)}</figcaption></figure>`
        : `<p>[${escapeHtml(node.attrs?.title ?? fallback)}]</p>`;
    }
    default:
      return childrenHtml(node, assetUrls);
  }
}

export function docToSemanticHtml(
  doc: NoteDoc,
  assetUrls: ReadonlyMap<string, string> = new Map(),
): string {
  return doc.content.map((node) => blockHtml(node, assetUrls)).join('');
}

export function completeHtmlDocument(
  title: string,
  body: string,
  options: { toc?: string; language?: string } = {},
): string {
  return `<!doctype html><html lang="${escapeHtml(options.language ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>${EXPORT_STYLES}</style></head><body>${options.toc ?? ''}${body}</body></html>`;
}

export function htmlText(value: unknown): string {
  return escapeHtml(value);
}
