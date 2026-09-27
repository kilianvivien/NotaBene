/**
 * One Markdown file from another app, turned into a `SourceNote`.
 *
 * Shared by every reader whose notes are Markdown files — a plain folder, an
 * Obsidian vault, a Notion export — because the differences between them are
 * small and the part they share is the part that is easy to get subtly wrong:
 * leaving code blocks alone, putting an image on a line of its own so the
 * parser sees it, keeping a link to another note a link.
 *
 * Nothing here decides what a link points at. The reader passes resolvers
 * that know its own conventions — Obsidian finds an image by file name
 * anywhere in the vault, Notion only by relative path — and the planner later
 * decides which note a `[[target]]` means once it has seen the whole batch.
 */
import { TAG_NAMESPACES, type ImportWarning, type TagNamespace } from '@/lib/schema';
import { frontmatterList, frontmatterString, parseFrontmatter } from '../frontmatter';
import {
  warn,
  type SourceAttachment,
  type SourceNote,
  type SourceTag,
} from './SourceImporter';

export type MarkdownFlavour = 'markdown' | 'obsidian' | 'notion';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isImagePath(path: string): boolean {
  return extensionOf(path) in IMAGE_MIME;
}

export function isMarkdownPath(path: string): boolean {
  const extension = extensionOf(path);
  return extension === 'md' || extension === 'markdown';
}

/** The image's type from its name. `assets.put` records it, and an image
 * stored as `application/octet-stream` does not render. */
export function imageMime(path: string): string {
  return IMAGE_MIME[extensionOf(path)] ?? 'application/octet-stream';
}

export function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

export function stripExtension(name: string): string {
  return name.replace(/\.(?:md|markdown)$/i, '');
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

/** Join `relative` onto `directory`, resolving `.` and `..`. `null` for a path
 * that climbs out of the source — it cannot name anything we were given. */
export function joinPath(directory: string, relative: string): string | null {
  const parts = directory ? directory.split('/') : [];
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** Percent-decoding that never throws: a stray `%` in a file name is data. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface ConvertInput {
  path: string;
  text: string;
  flavour: MarkdownFlavour;
  /** The reader's idea of the title, used when frontmatter has none. */
  title: string;
  folders: string[];
  sourceKey?: string;
  fileDates?: { createdAt?: string | null; updatedAt?: string | null };
  /** An image reference, decoded and without its fragment, to a picture. */
  resolveAttachment(href: string): SourceAttachment | null;
  /** A Markdown link's target to the `[[target]]` the planner should resolve:
   * a source path for a folder, a title for Notion. `null` if not a note. */
  resolveNoteLink(href: string): string | null;
}

const OBSIDIAN_CALLOUTS: Record<string, 'INFO' | 'WARN' | 'IMPORTANT'> = {
  warning: 'WARN',
  caution: 'WARN',
  attention: 'WARN',
  failure: 'WARN',
  fail: 'WARN',
  missing: 'WARN',
  danger: 'WARN',
  error: 'WARN',
  bug: 'WARN',
  important: 'IMPORTANT',
};

const DATE_KEYS = {
  created: ['created', 'date', 'created_at', 'creation date', 'date created'],
  updated: ['updated', 'modified', 'updated_at', 'last modified', 'date modified'],
};

function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  const year = new Date(time).getUTCFullYear();
  // A frontmatter "date" of 12 is a number someone typed, not a year.
  if (year < 1970 || year > 2200) return undefined;
  return new Date(time).toISOString();
}

function tagFromText(raw: string): SourceTag | null {
  const text = raw.trim().replace(/^#/, '').trim();
  if (!text) return null;
  const separator = text.indexOf(':');
  if (separator > 0) {
    const namespace = text.slice(0, separator).toLowerCase();
    if ((TAG_NAMESPACES as readonly string[]).includes(namespace)) {
      const name = text
        .slice(separator + 1)
        .trim()
        .slice(0, 100);
      return name ? { namespace: namespace as TagNamespace, name } : null;
    }
  }
  return { namespace: null, name: text.slice(0, 100) };
}

/** `https://arxiv.org/abs/…` is a source worth faceting by; the whole URL as
 * a tag name is not. */
function sourceTag(value: string): SourceTag | null {
  const text = value.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      return { namespace: 'source', name: new URL(text).hostname.replace(/^www\./, '') };
    } catch {
      return null;
    }
  }
  return { namespace: 'source', name: text.slice(0, 100) };
}

function addTag(tags: SourceTag[], tag: SourceTag | null): void {
  if (!tag) return;
  const exists = tags.some(
    (entry) =>
      entry.namespace === tag.namespace &&
      entry.name.localeCompare(tag.name, undefined, { sensitivity: 'accent' }) === 0,
  );
  if (!exists) tags.push(tag);
}

const FENCE = /^\s*(```|~~~)/;
/** Placeholder characters that cannot appear in a text file we would import. */
const NUL = String.fromCharCode(0);
const IMAGE_MARK = (index: number) => `${NUL}${index}${NUL}`;
const IMAGE_MARKS = new RegExp(`${NUL}(\\d+)${NUL}`, 'g');

export function convertMarkdownNote(input: ConvertInput): SourceNote {
  const warnings: ImportWarning[] = [];
  const tags: SourceTag[] = [];
  const attachments = new Map<string, SourceAttachment>();
  const obsidian = input.flavour === 'obsidian';

  const { data, body, unsupported } = parseFrontmatter(input.text);
  warn(warnings, 'frontmatterUnsupported', unsupported.length);

  for (const raw of [...frontmatterList(data.tags), ...frontmatterList(data.tag)]) {
    addTag(tags, tagFromText(raw));
  }
  for (const raw of [
    ...frontmatterList(data.author, /\s*[;&]\s*/),
    ...frontmatterList(data.authors, /\s*[;&]\s*/),
  ]) {
    const name = raw
      .replace(/^\[\[|\]\]$/g, '')
      .trim()
      .slice(0, 100);
    if (name) addTag(tags, { namespace: 'author', name });
  }
  for (const raw of [
    ...frontmatterList(data.source, /\s*[;]\s*/),
    ...frontmatterList(data.url, /\s+/),
  ]) {
    addTag(tags, sourceTag(raw));
  }
  const aliases = [
    ...frontmatterList(data.aliases, /\s*,\s*/),
    ...frontmatterList(data.alias, /\s*,\s*/),
  ]
    .map((alias) => alias.trim())
    .filter(Boolean);

  const title =
    (frontmatterString(data.title) ?? input.title).trim().slice(0, 500) || input.title;
  const created = DATE_KEYS.created
    .map((key) => parseDate(frontmatterString(data[key])))
    .find(Boolean);
  const updated = DATE_KEYS.updated
    .map((key) => parseDate(frontmatterString(data[key])))
    .find(Boolean);

  // The image placeholders below are NUL-delimited, so a stray NUL in a
  // damaged file must not be mistaken for one.
  let text = body.split(NUL).join('');
  // Obsidian comments are for the author; they never render, so they are not
  // part of the note.
  if (obsidian) text = text.replace(/%%[\s\S]*?%%/g, '');

  const images: { alt: string; key: string }[] = [];
  const addImage = (alt: string, attachment: SourceAttachment): string => {
    const key = `nb-source-${images.length}`;
    attachments.set(key, attachment);
    images.push({ alt: alt.replace(/[[\]\n]/g, ' ').trim(), key });
    return IMAGE_MARK(images.length - 1);
  };

  const rewriteSegment = (segment: string): string => {
    let out = segment;

    // `![[figure.png|300]]`, `![[Other note]]` — Obsidian's embed.
    out = out.replace(
      /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
      (_match, rawTarget: string, rawAlt?: string) => {
        const target = rawTarget.split('#')[0]!.trim();
        const alt = rawAlt && !/^\d+(x\d+)?$/.test(rawAlt.trim()) ? rawAlt.trim() : '';
        if (isImagePath(target)) {
          const attachment = input.resolveAttachment(target);
          if (attachment) return addImage(alt, attachment);
          warn(warnings, 'attachmentMissing');
          return basename(target);
        }
        if (!extensionOf(target) || isMarkdownPath(target)) {
          // Transclusion was declined (plan §17): the embed becomes the link it
          // is underneath, and the preview says so rather than inlining.
          warn(warnings, 'embedAsLink');
          return `[[${rawTarget.trim()}]]`;
        }
        warn(warnings, 'fileLinkDropped');
        return basename(target);
      },
    );

    // `![alt](path "title")`
    out = out.replace(
      /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g,
      (_match, rawAlt: string, rawHref: string) => {
        const href = rawHref.replace(/^<|>$/g, '');
        const alt = rawAlt.replace(/\|\d+(x\d+)?$/, '').trim();
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          if (/^https?:/i.test(href)) {
            // The webview loads no remote images, by CSP and by principle; a
            // link keeps the picture one click away.
            warn(warnings, 'remoteImage');
            return `[${alt || href}](${href})`;
          }
          warn(warnings, 'attachmentMissing');
          return alt;
        }
        const path = safeDecode(href.split('#')[0]!);
        const attachment = input.resolveAttachment(path);
        if (attachment) return addImage(alt, attachment);
        warn(warnings, 'attachmentMissing');
        return alt;
      },
    );

    // `[text](Other%20note.md)` — a link to another note, written as a path.
    out = out.replace(
      /(^|[^!])\[([^\]]+)\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g,
      (match, before: string, label: string, rawHref: string) => {
        const href = rawHref.replace(/^<|>$/g, '');
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return match;
        if (href.startsWith('#')) return `${before}${label}`;
        const path = safeDecode(href.split('#')[0]!);
        const target = input.resolveNoteLink(path);
        if (target) {
          const plain = stripExtension(basename(target));
          return label.trim() === plain || label.trim() === target
            ? `${before}[[${target}]]`
            : `${before}[[${target}|${label.replace(/\|/g, '/')}]]`;
        }
        if (isMarkdownPath(path)) {
          // A note that was not in the export: a link waiting for its note,
          // exactly as `[[Title]]` is.
          return `${before}[[${stripExtension(basename(path))}|${label.replace(/\|/g, '/')}]]`;
        }
        warn(warnings, 'fileLinkDropped');
        return `${before}${label}`;
      },
    );

    if (obsidian) {
      for (const match of out.matchAll(
        /(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu,
      )) {
        addTag(tags, tagFromText(match[1]!));
      }
    }
    return out;
  };

  /** Rewrite one line outside code: inline code spans stay exactly as typed. */
  const rewriteLine = (line: string): string =>
    line
      .split(/(`[^`]*`)/)
      .map((part, index) => (index % 2 === 1 ? part : rewriteSegment(part)))
      .join('');

  const out: string[] = [];
  let fence: string | null = null;
  let mathBlock = false;
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = FENCE.exec(rawLine);
    if (fence) {
      out.push(rawLine);
      if (fenceMatch && fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      out.push(rawLine);
      continue;
    }
    if (/^\s*\$\$\s*$/.test(rawLine)) {
      mathBlock = !mathBlock;
      out.push(rawLine);
      continue;
    }
    if (mathBlock) {
      out.push(rawLine);
      continue;
    }

    let line = rawLine;
    if (obsidian) line = line.replace(/\s\^[A-Za-z0-9-]+\s*$/, '');

    // `> [!warning]- Title` → the three callout kinds NotaBene has, or a toggle.
    const callout = /^(\s*>\s*)\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/.exec(line);
    if (callout) {
      const [, prefix, kind, fold, calloutTitle] = callout;
      const label =
        calloutTitle?.trim() || kind!.charAt(0).toUpperCase() + kind!.slice(1);
      if (fold) {
        out.push(`${prefix}[!TOGGLE ${label.replace(/\]/g, ')')}]`);
      } else {
        out.push(`${prefix}[!${OBSIDIAN_CALLOUTS[kind!.toLowerCase()] ?? 'INFO'}]`);
        if (calloutTitle?.trim()) out.push(`${prefix}**${calloutTitle.trim()}**`);
      }
      continue;
    }

    const rewritten = rewriteLine(line);
    if (!rewritten.includes(NUL)) {
      out.push(rewritten);
      continue;
    }
    // An image is a block in NotaBene. Give each one a line of its own, with
    // blank lines around it so the paragraph above does not swallow it, and
    // keep a blockquote's `>` so a figure inside a callout stays inside it.
    const prefix = /^(\s*>\s?)*/.exec(rewritten)?.[0] ?? '';
    const blank = prefix.trimEnd();
    const pieces = rewritten.slice(prefix.length).split(IMAGE_MARKS);
    pieces.forEach((piece, index) => {
      if (index % 2 === 1) {
        const image = images[Number(piece)];
        if (!image) return;
        out.push(blank, `${prefix}![${image.alt}](asset:${image.key})`, blank);
      } else if (piece.trim()) {
        out.push(`${prefix}${piece.trim()}`);
      }
    });
  }

  let markdown = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // A first heading that only repeats the title is the title twice: Notion
  // writes one on every page, and plenty of Obsidian notes open with one.
  const firstHeading = /^#\s+(.+?)\s*(?:\n|$)/.exec(markdown);
  if (firstHeading && firstHeading[1]!.trim().toLowerCase() === title.toLowerCase()) {
    markdown = markdown.slice(firstHeading[0].length).replace(/^\n+/, '');
  }

  return {
    sourceKey: input.sourceKey ?? input.path,
    displayPath: input.path,
    title,
    markdown,
    folders: input.folders,
    tags,
    aliases,
    createdAt: created ?? input.fileDates?.createdAt ?? undefined,
    updatedAt: updated ?? input.fileDates?.updatedAt ?? undefined,
    attachments,
    warnings,
  };
}
