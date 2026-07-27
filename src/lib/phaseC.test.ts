import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createCourse, createNote, newId, type Tag } from '@/lib/schema';
import { viewToQuery } from '@/app/shell/viewQuery';

beforeEach(() => {
  memoryLibraryAdapter.reset();
});

describe('Phase C library behavior', () => {
  it('searches French text without requiring accents', async () => {
    await memoryLibraryAdapter.upsertNote(
      createNote({
        title: 'Révisions',
        doc: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Notion recherchée et résumé.' }],
            },
          ],
        },
      }),
    );

    expect(await memoryLibraryAdapter.queryNotes({ text: 'recherche' })).toHaveLength(1);
    const resume = await memoryLibraryAdapter.queryNotes({ text: 'resume' });
    expect(resume).toHaveLength(1);
    expect(resume[0]?.snippet).toContain('<mark>');
  });

  it('includes course, typed-tag, and attachment names in free-text search', async () => {
    const course = createCourse({ name: 'Mathématiques' });
    const tag: Tag = {
      id: newId(),
      namespace: 'prof',
      name: 'Élodie',
      color: '#3478c7',
    };
    const note = createNote({ courseId: course.id, tagIds: [tag.id] });
    await memoryLibraryAdapter.upsertCourse(course);
    await memoryLibraryAdapter.upsertTag(tag);
    await memoryLibraryAdapter.upsertNote(note);
    await memoryLibraryAdapter.upsertAttachment({
      id: newId(),
      noteId: note.id,
      assetId: 'asset',
      name: 'Formulaire intégrales.pdf',
      createdAt: new Date().toISOString(),
    });

    for (const text of ['mathematiques', 'elodie', 'integrales']) {
      expect(await memoryLibraryAdapter.queryNotes({ text })).toHaveLength(1);
    }
  });

  it('keeps backlinks attached to ids after the target title changes', async () => {
    const target = createNote({ title: 'Analyse' });
    const source = createNote({
      title: 'Index',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'wikiLink',
                attrs: { noteId: target.id, title: target.title },
              },
            ],
          },
        ],
      },
    });
    await memoryLibraryAdapter.upsertNote(target);
    await memoryLibraryAdapter.upsertNote(source);
    await memoryLibraryAdapter.upsertNote({ ...target, title: 'Analyse avancée' });

    expect(await memoryLibraryAdapter.listBacklinks(target.id)).toMatchObject([
      { sourceId: source.id, sourceTitle: 'Index' },
    ]);
  });

  it('resolves named filters and persisted smart folders through the shared query map', () => {
    const course = createCourse({ name: 'Droit public' });
    const tag: Tag = {
      id: newId(),
      namespace: 'type',
      name: 'lecture',
      color: '#4b7c58',
    };
    const query = viewToQuery(
      { kind: 'savedSearch', savedSearchId: 'saved' },
      {
        courses: [course],
        tags: [tag],
        savedSearches: [
          {
            id: 'saved',
            name: 'Lectures',
            query: 'course:"Droit public" type:lecture',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    );

    expect(query.courseId).toBe(course.id);
    expect(query.tagIds).toEqual([tag.id]);
  });
});
