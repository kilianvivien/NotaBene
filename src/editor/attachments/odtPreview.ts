import { unzipSync } from 'fflate';

interface OdtStyle {
  family: string;
  parent?: string;
  properties: Record<string, string>;
}

const decoder = new TextDecoder('utf-8');

function xml(source: Uint8Array): XMLDocument {
  const parsed = new DOMParser().parseFromString(
    decoder.decode(source),
    'application/xml',
  );
  const error = parsed.querySelector('parsererror');
  if (error) throw new Error(error.textContent ?? 'Invalid OpenDocument XML');
  return parsed;
}

function safeCss(value: string | null): string | null {
  if (!value || /(?:expression|javascript|url\s*\()/i.test(value)) return null;
  return value;
}

function put(properties: Record<string, string>, key: string, value: string | null) {
  const safe = safeCss(value);
  if (safe) properties[key] = safe;
}

function childByTag(element: Element, tagName: string): Element | null {
  return [...element.children].find((child) => child.tagName === tagName) ?? null;
}

function styleProperties(element: Element): Record<string, string> {
  const properties: Record<string, string> = {};
  const text = childByTag(element, 'style:text-properties');
  const paragraph = childByTag(element, 'style:paragraph-properties');
  const cell = childByTag(element, 'style:table-cell-properties');
  const graphic = childByTag(element, 'style:graphic-properties');

  if (text) {
    put(properties, 'font-family', text.getAttribute('style:font-name'));
    put(properties, 'font-size', text.getAttribute('fo:font-size'));
    put(properties, 'font-style', text.getAttribute('fo:font-style'));
    put(properties, 'font-weight', text.getAttribute('fo:font-weight'));
    put(properties, 'color', text.getAttribute('fo:color'));
    put(properties, 'background-color', text.getAttribute('fo:background-color'));
    put(properties, 'letter-spacing', text.getAttribute('fo:letter-spacing'));
    if (text.getAttribute('style:text-underline-style') !== 'none') {
      properties['text-decoration-line'] = 'underline';
    }
    if (text.getAttribute('style:text-line-through-style') !== 'none') {
      properties['text-decoration-line'] = [
        properties['text-decoration-line'],
        'line-through',
      ]
        .filter(Boolean)
        .join(' ');
    }
    const position = text.getAttribute('style:text-position') ?? '';
    if (position.startsWith('super')) properties['vertical-align'] = 'super';
    if (position.startsWith('sub')) properties['vertical-align'] = 'sub';
  }

  if (paragraph) {
    put(properties, 'text-align', paragraph.getAttribute('fo:text-align'));
    put(properties, 'line-height', paragraph.getAttribute('fo:line-height'));
    put(properties, 'text-indent', paragraph.getAttribute('fo:text-indent'));
    put(properties, 'margin-left', paragraph.getAttribute('fo:margin-left'));
    put(properties, 'margin-right', paragraph.getAttribute('fo:margin-right'));
    put(properties, 'margin-top', paragraph.getAttribute('fo:margin-top'));
    put(properties, 'margin-bottom', paragraph.getAttribute('fo:margin-bottom'));
    put(properties, 'background-color', paragraph.getAttribute('fo:background-color'));
    if (paragraph.getAttribute('fo:break-before') === 'page') {
      properties['break-before'] = 'page';
    }
  }

  for (const source of [cell, graphic]) {
    if (!source) continue;
    put(properties, 'background-color', source.getAttribute('fo:background-color'));
    put(properties, 'border', source.getAttribute('fo:border'));
    put(properties, 'padding', source.getAttribute('fo:padding'));
    put(properties, 'margin-left', source.getAttribute('fo:margin-left'));
    put(properties, 'margin-right', source.getAttribute('fo:margin-right'));
  }
  return properties;
}

function collectStyles(documents: XMLDocument[]): Map<string, OdtStyle> {
  const styles = new Map<string, OdtStyle>();
  for (const document of documents) {
    for (const element of document.getElementsByTagName('style:style')) {
      const name = element.getAttribute('style:name');
      if (!name) continue;
      styles.set(name, {
        family: element.getAttribute('style:family') ?? '',
        parent: element.getAttribute('style:parent-style-name') ?? undefined,
        properties: styleProperties(element),
      });
    }
  }
  return styles;
}

function resolvedStyle(
  name: string | null,
  styles: Map<string, OdtStyle>,
  seen = new Set<string>(),
): Record<string, string> {
  if (!name || seen.has(name)) return {};
  const style = styles.get(name);
  if (!style) return {};
  seen.add(name);
  return {
    ...resolvedStyle(style.parent ?? null, styles, seen),
    ...style.properties,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function imageMime(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'webp') return 'image/webp';
  return 'image/png';
}

function applyStyle(target: HTMLElement, source: Element, styles: Map<string, OdtStyle>) {
  const name =
    source.getAttribute('text:style-name') ??
    source.getAttribute('table:style-name') ??
    source.getAttribute('draw:style-name');
  for (const [property, value] of Object.entries(resolvedStyle(name, styles))) {
    target.style.setProperty(property, value);
  }
}

function convertElement(
  source: Element,
  output: Document,
  styles: Map<string, OdtStyle>,
  files: Record<string, Uint8Array>,
): Node {
  const tag = source.tagName;
  if (
    tag === 'text:tracked-changes' ||
    tag === 'office:annotation' ||
    tag === 'office:forms'
  ) {
    return output.createDocumentFragment();
  }

  let target: HTMLElement | null = null;
  if (tag === 'text:h') {
    const level = Math.min(
      6,
      Math.max(1, Number(source.getAttribute('text:outline-level')) || 1),
    );
    target = output.createElement(`h${level}`);
  } else if (tag === 'text:p') {
    target = output.createElement('p');
  } else if (tag === 'text:span') {
    target = output.createElement('span');
  } else if (tag === 'text:a') {
    target = output.createElement('a');
    const href = source.getAttribute('xlink:href') ?? '';
    if (/^(?:https?:|mailto:)/i.test(href)) {
      target.setAttribute('href', href);
      target.setAttribute('target', '_blank');
      target.setAttribute('rel', 'noreferrer');
    }
  } else if (tag === 'text:list') {
    target = output.createElement('ul');
  } else if (tag === 'text:list-item') {
    target = output.createElement('li');
  } else if (tag === 'table:table') {
    target = output.createElement('table');
  } else if (tag === 'table:table-row') {
    target = output.createElement('tr');
  } else if (tag === 'table:table-cell' || tag === 'table:covered-table-cell') {
    const cell = output.createElement('td');
    const columns = Number(source.getAttribute('table:number-columns-spanned'));
    const rows = Number(source.getAttribute('table:number-rows-spanned'));
    if (columns > 1) cell.colSpan = columns;
    if (rows > 1) cell.rowSpan = rows;
    target = cell;
  } else if (tag === 'draw:frame') {
    target = output.createElement('figure');
    putFrameSize(target, source);
  } else if (tag === 'draw:image') {
    const image = output.createElement('img');
    const path = (source.getAttribute('xlink:href') ?? '').replace(/^\.\//, '');
    const bytes = files[path];
    if (bytes) image.src = `data:${imageMime(path)};base64,${base64(bytes)}`;
    image.alt = source.getAttribute('draw:name') ?? '';
    return image;
  } else if (tag === 'text:line-break') {
    return output.createElement('br');
  } else if (tag === 'text:tab') {
    return output.createTextNode('\t');
  } else if (tag === 'text:s') {
    return output.createTextNode(
      ' '.repeat(Math.max(1, Number(source.getAttribute('text:c')) || 1)),
    );
  } else if (tag === 'text:soft-page-break') {
    const marker = output.createElement('hr');
    marker.className = 'nb-odt-page-break';
    return marker;
  }

  if (!target) {
    const fragment = output.createDocumentFragment();
    appendChildren(fragment, source, output, styles, files);
    return fragment;
  }
  applyStyle(target, source, styles);
  appendChildren(target, source, output, styles, files);
  return target;
}

function putFrameSize(target: HTMLElement, source: Element) {
  const width = safeCss(source.getAttribute('svg:width'));
  const height = safeCss(source.getAttribute('svg:height'));
  if (width) target.style.width = width;
  if (height) target.style.height = height;
}

function appendChildren(
  target: Node,
  source: Node,
  output: Document,
  styles: Map<string, OdtStyle>,
  files: Record<string, Uint8Array>,
) {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(output.createTextNode(child.textContent ?? ''));
    } else if (child instanceof Element) {
      target.appendChild(convertElement(child, output, styles, files));
    }
  }
}

export function renderOdtHtml(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const contentBytes = files['content.xml'];
  if (!contentBytes) throw new Error('The ODT file has no content.xml');
  const content = xml(contentBytes);
  const stylesDocument = files['styles.xml'] ? xml(files['styles.xml']) : null;
  const styles = collectStyles([content, ...(stylesDocument ? [stylesDocument] : [])]);
  const body = content.getElementsByTagName('office:text')[0] ?? null;
  if (!body) throw new Error('The ODT file has no text body');

  const output = document.implementation.createHTMLDocument('');
  const article = output.createElement('article');
  appendChildren(article, body, output, styles, files);
  return article.innerHTML;
}
