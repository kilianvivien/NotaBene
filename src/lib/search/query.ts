/**
 * The search box grammar.
 *
 * One parser, used by the in-app search bar, saved searches, and the
 * `search_notes` MCP tool — an agent and a student write the same query
 * language, which is the whole point of exposing search over MCP at all.
 *
 * Grammar: bare words are free text; `key:value` pairs are filters. Values may
 * be quoted to include spaces. Unknown keys fall back to free text rather than
 * erroring, because a student typing `http://…` should not get a syntax error.
 */
import type { NoteQuery } from '@/lib/adapters';

/** Filter keys that name something the parser cannot resolve on its own.
 * `course` names a course; `tag` a plain tag; the rest are the typed tag
 * namespaces from the schema. */
const NAME_FILTERS = ['course', 'tag', 'topic', 'prof', 'semester', 'type', 'exam'] as const;
type NameFilter = (typeof NAME_FILTERS)[number];

export interface ParsedQuery extends NoteQuery {
  /** Filters that named a course/tag by *name*; resolving those to ids needs
   * the library, which the parser deliberately does not have. */
  unresolved: { key: NameFilter; value: string }[];
}

const HAS_VALUES = new Set(['image', 'drawing', 'table', 'attachment']);

/** Split on whitespace, but keep `key:"two words"` and `"a phrase"` together. */
function tokenize(input: string): string[] {
  return input.match(/(?:[^\s"]+"[^"]*"|"[^"]*"|[^\s"]+)/g) ?? [];
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/s, '$1');
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
      freeText.push(unquote(token));
      continue;
    }

    const key = token.slice(0, separator).toLowerCase();
    const value = unquote(token.slice(separator + 1));
    if (!value) {
      freeText.push(unquote(token));
      continue;
    }

    if ((NAME_FILTERS as readonly string[]).includes(key)) {
      unresolved.push({ key: key as NameFilter, value });
      continue;
    }

    switch (key) {
      case 'has':
        if (HAS_VALUES.has(value)) has.push(value as (typeof has)[number]);
        else freeText.push(unquote(token));
        break;
      case 'after': {
        const parsed = parseDate(value);
        if (parsed) query.createdAfter = parsed;
        else freeText.push(unquote(token));
        break;
      }
      case 'before': {
        const parsed = parseDate(value);
        if (parsed) query.createdBefore = parsed;
        else freeText.push(unquote(token));
        break;
      }
      case 'on': {
        const start = parseDate(value);
        const end = endOfDay(value);
        if (start && end) {
          query.createdAfter = start;
          query.createdBefore = end;
        } else {
          freeText.push(unquote(token));
        }
        break;
      }
      case 'is':
        if (value === 'pinned') query.pinned = true;
        else if (value === 'archived') query.scope = 'archived';
        else if (value === 'trashed') query.scope = 'trashed';
        else freeText.push(unquote(token));
        break;
      default:
        freeText.push(unquote(token));
    }
  }

  if (freeText.length > 0) query.text = freeText.join(' ');
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
