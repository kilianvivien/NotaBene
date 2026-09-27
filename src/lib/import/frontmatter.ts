/**
 * The YAML block at the top of a Markdown note, read as far as notes need.
 *
 * Deliberately a small subset rather than a YAML dependency: `key: scalar`,
 * `key: [a, b]` and a block sequence of scalars cover what Obsidian, Notion and
 * NotaBene's own Markdown export (`exportCommands.ts`) write. Anything else — a
 * nested map, a multi-line string, an anchor — is not guessed at: the key is
 * left out and named in `unsupported`, so the preview can say what was lost.
 * YAML's full grammar is a large surface to run over files from anywhere, for
 * fields nobody maps onto anything.
 */

export type FrontmatterValue = string | string[];

export interface Frontmatter {
  data: Record<string, FrontmatterValue>;
  /** The note with the block removed. */
  body: string;
  /** Keys that were present and could not be read. */
  unsupported: string[];
}

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const KEY = /^([A-Za-z_][\w -]*?)[ \t]*:(?:[ \t]+(.*))?$/;
const ITEM = /^[ \t]+-[ \t]+(.*)$|^-[ \t]+(.*)$/;

function scalar(raw: string): string | null {
  const value = raw.trim();
  if (!value || value === '~' || value === 'null') return '';
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return null;
    return value.slice(1, -1).replaceAll("''", "'");
  }
  // Block scalars, anchors, aliases, tags and maps are the parts left out.
  if (/^[|>&*!{]/.test(value)) return null;
  // An unquoted value may carry a trailing comment.
  return value.replace(/[ \t]+#.*$/, '').trim();
}

/** `[a, "b, c", 'd']` — split on commas outside quotes. */
function flowSequence(raw: string): string[] | null {
  const inner = raw.trim().slice(1, -1);
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ',') {
      items.push(current);
      current = '';
    } else if (char === '[' || char === '{') {
      return null;
    } else {
      current += char;
    }
  }
  if (quote) return null;
  if (current.trim()) items.push(current);
  const values = items.map(scalar);
  if (values.some((value) => value === null)) return null;
  return (values as string[]).filter(Boolean);
}

export function parseFrontmatter(markdown: string): Frontmatter {
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (!OPEN.test(lines[0] ?? '')) return { data: {}, body: text, unsupported: [] };
  const end = lines.findIndex((line, index) => index > 0 && CLOSE.test(line));
  // An opening fence with no close is a horizontal rule, not metadata.
  if (end < 0) return { data: {}, body: text, unsupported: [] };

  const data: Record<string, FrontmatterValue> = {};
  const unsupported = new Set<string>();
  let listKey: string | null = null;

  for (const line of lines.slice(1, end)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const item = ITEM.exec(line);
    if (item && listKey) {
      const value = scalar(item[1] ?? item[2] ?? '');
      const list = data[listKey];
      if (value === null || !Array.isArray(list)) {
        unsupported.add(listKey);
        delete data[listKey];
        listKey = null;
      } else if (value) {
        list.push(value);
      }
      continue;
    }

    const key = KEY.exec(line);
    if (!key || /^\s/.test(line)) {
      // Indented content that is not a list item belongs to a nested map.
      if (listKey) {
        unsupported.add(listKey);
        delete data[listKey];
      }
      listKey = null;
      continue;
    }

    const name = key[1]!.trim();
    const raw = key[2]?.trim() ?? '';
    listKey = null;
    if (!raw) {
      // Either a block sequence follows, or nothing does.
      data[name] = [];
      listKey = name;
      continue;
    }
    if (raw.startsWith('[')) {
      const values = raw.endsWith(']') ? flowSequence(raw) : null;
      if (values) data[name] = values;
      else unsupported.add(name);
      continue;
    }
    const value = scalar(raw);
    if (value === null) unsupported.add(name);
    else data[name] = value;
  }

  // `key:` with nothing under it is an empty value, not an empty list.
  for (const [name, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length === 0) data[name] = '';
  }

  return {
    data,
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, ''),
    unsupported: [...unsupported],
  };
}

/** A field as a list, whether it was written as one or as a single value —
 * `tags: physics` and `tags: [physics]` mean the same thing. Tags split on
 * spaces too, the way Obsidian reads them; a name like an author's must pass
 * a separator that keeps "Ada Lovelace" whole. */
export function frontmatterList(
  value: FrontmatterValue | undefined,
  separator: RegExp = /[,\s]+/,
): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function frontmatterString(
  value: FrontmatterValue | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || undefined;
}
