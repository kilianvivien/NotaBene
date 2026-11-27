/**
 * The search box grammar.
 *
 * One parser, used by the in-app search bar, saved searches, and the
 * `search_notes` MCP tool — an agent and a student write the same query
 * language, which is the whole point of exposing search over MCP at all.
 *
 * Bare words are ANDed, double quotes match a phrase, and uppercase OR separates
 * alternatives. A leading minus excludes a word or phrase from every branch.
 * `key:value` pairs are filters across all branches. Unknown keys remain free
 * text so that a pasted URL is searchable.
 */
import type { NoteQuery, NoteSearchTerm, NoteTextExpression } from '@/lib/adapters';
import type { Course, Tag } from '@/lib/schema';

/** Filter keys that name something the parser cannot resolve on its own.
 * `course` names a course; `tag` a plain tag; the rest are the typed tag
 * namespaces from the schema. */
const NAME_FILTERS = [
  'course',
  'tag',
  'topic',
  'prof',
  'semester',
  'type',
  'exam',
  'author',
  'source',
] as const;
type NameFilter = (typeof NAME_FILTERS)[number];

export interface ParsedQuery extends NoteQuery {
  /** Filters that named a course/tag by *name*; resolving those to ids needs
   * the library, which the parser deliberately does not have. */
  unresolved: { key: NameFilter; value: string }[];
}

const HAS_VALUES = new Set(['image', 'drawing', 'table', 'attachment']);

/** Split on whitespace, but keep `key:"two words"` and `"a phrase"` together. */
function tokenize(input: string): string[] {
  return input.match(/(?:[^\s"]*"[^"]*"(?=\s|$)|-?"[^"]*$|\S+)/g) ?? [];
}

const quoted = /^"[^"]*"$/;

function searchTerm(token: string): NoteSearchTerm {
  const phrase = quoted.test(token);
  return { text: phrase ? token.slice(1, -1) : token, phrase };
}

function parseText(tokens: string[]): NoteTextExpression {
  const positive: (NoteSearchTerm | 'OR')[] = [];
  const exclude: NoteSearchTerm[] = [];

  for (const token of tokens) {
    const unfinished = token.match(/^-?"([^"]*)$/)?.[1];
    const operand = token.slice(1);
    if (unfinished?.trim()) {
      // Keep finding the words typed so far while the closing quote is missing.
      positive.push(
        ...unfinished
          .trim()
          .split(/\s+/)
          .map((text) => ({ text, phrase: false })),
      );
    } else if (
      token.startsWith('-') &&
      /[\p{L}\p{N}\p{Co}]/u.test(operand) &&
      (!operand.startsWith('"') || quoted.test(operand))
    ) {
      exclude.push(searchTerm(operand));
    } else if (token === 'OR') {
      positive.push(token);
    } else if (quoted.test(token)) {
      positive.push(searchTerm(token));
    } else {
      // A quoted value attached to an unknown facet is still ordinary text.
      positive.push(...token.trim().split(/\s+/).map(searchTerm));
    }
  }

  const groups: NoteSearchTerm[][] = [];
  let group: NoteSearchTerm[] = [];
  for (const [index, token] of positive.entries()) {
    // Give a standalone or dangling OR the same meaning as lowercase "or".
    const left = positive[index - 1];
    const right = positive[index + 1];
    if (token === 'OR' && left && left !== 'OR' && right && right !== 'OR') {
      groups.push(group);
      group = [];
    } else {
      group.push(token === 'OR' ? searchTerm(token) : token);
    }
  }
  if (group.length) groups.push(group);
  return { groups, exclude };
}

/** `before:`/`after:`/`on:` accept `YYYY-MM-DD`; anything else is ignored. */
function parseDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function endOfDay(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return new Date(`${value}T23:59:59.999Z`).toISOString();
}

export function parseQuery(input: string): ParsedQuery {
  const freeText: string[] = [];
  const unresolved: ParsedQuery['unresolved'] = [];
  const has: NonNullable<NoteQuery['has']> = [];
  const query: ParsedQuery = { unresolved: [] };

  for (const token of tokenize(input)) {
    const separator = token.indexOf(':');
    if (separator <= 0) {
      freeText.push(token);
      continue;
    }

    const key = token.slice(0, separator).toLowerCase();
    const rawValue = token.slice(separator + 1);
    const value = quoted.test(rawValue) ? rawValue.slice(1, -1) : rawValue;
    if (!value || (value === rawValue && rawValue.startsWith('"'))) {
      freeText.push(token);
      continue;
    }

    if ((NAME_FILTERS as readonly string[]).includes(key)) {
      unresolved.push({ key: key as NameFilter, value });
      continue;
    }

    switch (key) {
      case 'has':
        if (HAS_VALUES.has(value)) has.push(value as (typeof has)[number]);
        else freeText.push(token);
        break;
      case 'after': {
        const parsed = parseDate(value);
        if (parsed) query.createdAfter = parsed;
        else freeText.push(token);
        break;
      }
      case 'before': {
        const parsed = parseDate(value);
        if (parsed) query.createdBefore = parsed;
        else freeText.push(token);
        break;
      }
      case 'on': {
        const start = parseDate(value);
        const end = endOfDay(value);
        if (start && end) {
          query.createdAfter = start;
          query.createdBefore = end;
        } else {
          freeText.push(token);
        }
        break;
      }
      case 'is':
        if (value === 'pinned') query.pinned = true;
        else if (value === 'archived') query.scope = 'archived';
        else if (value === 'trashed') query.scope = 'trashed';
        else freeText.push(token);
        break;
      default:
        freeText.push(token);
    }
  }

  if (freeText.length > 0) {
    query.textExpression = parseText(freeText);
    const text = query.textExpression.groups
      .flat()
      .map((term) => term.text)
      .join(' ')
      .trim();
    if (text) query.text = text;
  }
  if (has.length > 0) query.has = has;
  query.unresolved = unresolved;
  return query;
}

/**
 * Fold name-based filters into id-based ones once the library is available.
 * Names that match nothing are dropped rather than silently widening the
 * result set — a typo'd `course:` should return nothing, not everything.
 */
export function resolveQuery(
  parsed: ParsedQuery,
  lookup: {
    courseIdByName(name: string): string | undefined;
    tagIdByName(namespace: string | null, name: string): string | undefined;
  },
): NoteQuery & { unresolvable: boolean } {
  const { unresolved, ...query } = parsed;
  const tagIds: string[] = [];
  let unresolvable = false;

  for (const filter of unresolved) {
    if (filter.key === 'course') {
      const courseId = lookup.courseIdByName(filter.value);
      if (courseId) query.courseId = courseId;
      else unresolvable = true;
      continue;
    }
    const namespace = filter.key === 'tag' ? null : filter.key;
    const tagId = lookup.tagIdByName(namespace, filter.value);
    if (tagId) tagIds.push(tagId);
    else unresolvable = true;
  }

  if (tagIds.length > 0) query.tagIds = tagIds;
  return { ...query, unresolvable };
}

/** The search field and its suggestion list resolve the same names. */
export function resolveSearch(
  input: string,
  courses: readonly Course[] = [],
  tags: readonly Tag[] = [],
): NoteQuery & { unresolvable: boolean } {
  const sameName = (left: string, right: string) =>
    left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;

  return resolveQuery(parseQuery(input), {
    courseIdByName: (name) => courses.find((course) => sameName(course.name, name))?.id,
    tagIdByName: (namespace, name) =>
      tags.find((tag) => tag.namespace === namespace && sameName(tag.name, name))?.id,
  });
}
