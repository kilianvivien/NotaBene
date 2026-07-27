/** Translate a sidebar view into the note query behind it. Kept out of the
 * components so the same mapping serves the note list, export selection, and
 * the `search_notes` MCP tool. */
import type { NoteQuery } from '@/lib/adapters';
import { parseQuery } from '@/lib/search/query';
import type { ViewKind } from '@/lib/state/uiStore';

const PAGE_SIZE = 200;

export function viewToQuery(view: ViewKind): NoteQuery {
  const base: NoteQuery = { scope: 'live', sort: 'updated', limit: PAGE_SIZE };

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
      const { unresolved: _unresolved, ...parsed } = parseQuery(view.query);
      return { ...base, ...parsed, sort: 'relevance' };
    }
    case 'savedSearch':
    case 'all':
    default:
      return base;
  }
}
