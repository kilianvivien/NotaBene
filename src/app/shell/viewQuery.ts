/** Translate a sidebar view into the note query behind it. Kept out of the
 * components so the same mapping serves the note list, export selection, and
 * the `search_notes` MCP tool. */
import type { NoteQuery } from '@/lib/adapters';
import type { Course, SavedSearch, Tag } from '@/lib/schema';
import { parseQuery, resolveQuery } from '@/lib/search/query';
import type { ViewKind } from '@/lib/state/uiStore';

const PAGE_SIZE = 200;

export interface ViewQueryContext {
  courses?: Course[];
  tags?: Tag[];
  savedSearches?: SavedSearch[];
  sort?: NonNullable<NoteQuery['sort']>;
  searchScope?: 'all' | 'course';
  searchCourseId?: string | null;
}

function parsedSearch(raw: string, context: ViewQueryContext): NoteQuery {
  const resolved = resolveQuery(parseQuery(raw), {
    courseIdByName(name) {
      return context.courses?.find(
        (course) =>
          course.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0,
      )?.id;
    },
    tagIdByName(namespace, name) {
      return context.tags?.find(
        (tag) =>
          tag.namespace === namespace &&
          tag.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0,
      )?.id;
    },
  });
  const { unresolvable, ...query } = resolved;
  // A deliberately impossible tag id makes an unresolved named filter return
  // zero rows rather than silently widening the search.
  if (unresolvable) query.tagIds = ['__notabene_unresolvable__'];
  return query;
}

export function viewToQuery(view: ViewKind, context: ViewQueryContext = {}): NoteQuery {
  const base: NoteQuery = {
    scope: 'live',
    sort: context.sort ?? 'updated',
    limit: PAGE_SIZE,
  };

  switch (view.kind) {
    case 'inbox':
      // The inbox is simply "not filed under a course yet".
      return { ...base, courseId: null };
    case 'pinned':
      return { ...base, pinned: true };
    case 'archived':
      return { ...base, scope: 'archived' };
    case 'trash':
      return { ...base, scope: 'trashed' };
    case 'recents':
      return { ...base, limit: 50 };
    case 'course':
      return { ...base, courseId: view.courseId, sectionId: view.sectionId };
    case 'tag':
      return { ...base, tagIds: [view.tagId] };
    case 'search': {
      const parsed = parsedSearch(view.query, context);
      const courseId =
        context.searchScope === 'course' && context.searchCourseId
          ? context.searchCourseId
          : parsed.courseId;
      return {
        ...base,
        ...parsed,
        courseId,
        sort: context.sort ?? (parsed.text ? 'relevance' : 'updated'),
      };
    }
    case 'savedSearch': {
      const saved = context.savedSearches?.find(
        (search) => search.id === view.savedSearchId,
      );
      return saved ? { ...base, ...parsedSearch(saved.query, context) } : base;
    }
    case 'all':
    default:
      return base;
  }
}
