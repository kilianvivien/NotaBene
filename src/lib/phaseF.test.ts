import { beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { exporter, library, storage } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createCourseCommand, createSectionCommand } from '@/lib/commands';
import { TOOL_HANDLERS } from '@/lib/mcp/toolHandlers';
import { useMcpStore } from '@/lib/state/mcpStore';
import { useUiStore } from '@/lib/state/uiStore';
import type { CommandContext, CommandResult } from '@/lib/commands';
import type { Note } from '@/lib/schema';

const AGENT: CommandContext = { source: 'agent', agentName: 'contract-test' };
type Handler = (
  args: unknown,
  context: CommandContext,
) => Promise<CommandResult<unknown>>;

function call(method: keyof typeof TOOL_HANDLERS, args?: unknown) {
  return (TOOL_HANDLERS[method] as Handler)(args, AGENT);
}

async function createFixture() {
  const course = await createCourseCommand({ name: 'Calculus', professor: 'Noether' });
  if (!course.ok) throw new Error(course.message);
  const section = await createSectionCommand({
    courseId: course.value.id,
    name: 'Limits',
  });
  if (!section.ok) throw new Error(section.message);
  const note = await call('create_note', {
    title: 'Lecture one',
    courseId: course.value.id,
    sectionId: section.value.id,
    markdown: '# Limits\n\nA derivative is a limit.',
    tags: ['topic:calculus'],
  });
  if (!note.ok) throw new Error(note.message);
  return {
    course: course.value,
    section: section.value,
    note: note.value as Awaited<ReturnType<typeof library.getNote>> & {},
  };
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  useUiStore.setState({ agentBusy: false });
  useMcpStore.setState({
    activeRequests: 0,
    activities: [],
    error: null,
    setupResult: null,
  });
  vi.restoreAllMocks();
});

describe('Phase F MCP tool contracts', () => {
  it('reports live application state', async () => {
    const result = await call('get_app_state');
    expect(result.ok).toBe(true);
    // Read the version rather than pinning it, so a release bump does not
    // fail a test about the tool contract.
    if (result.ok) expect(result.value).toMatchObject({ appVersion: pkg.version });
  });

  it('lists courses with their sections', async () => {
    const { course, section } = await createFixture();
    const result = await call('list_courses');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: course.id,
            sections: [expect.objectContaining({ id: section.id })],
          }),
        ]),
      );
    }
  });

  it('lists the existing tag taxonomy without changing it', async () => {
    await createFixture();
    const result = await call('list_tags');
    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ name: 'calculus', namespace: 'topic' })],
    });
  });

  it('validates list paging', async () => {
    const result = await call('list_notes', { limit: 0 });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('searches with the same course and text grammar as the app', async () => {
    await createFixture();
    const result = await call('search_notes', {
      query: 'course:Calculus derivative',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([expect.objectContaining({ title: 'Lecture one' })]);
    }
  });

  it('reads Markdown, structured JSON, course, tags, and a revision token', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const result = await call('read_note', { noteId: note.id, format: 'both' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        id: note.id,
        updatedAt: note.updatedAt,
        markdown: expect.stringContaining('derivative'),
        doc: expect.objectContaining({ type: 'doc' }),
        course: expect.objectContaining({ name: 'Calculus' }),
        tags: [expect.objectContaining({ name: 'calculus' })],
      });
    }
  });

  it('reads indexed blocks and applies only targeted note patches', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const blocks = await call('read_note', { noteId: note.id, format: 'blocks' });
    expect(blocks).toMatchObject({
      ok: true,
      value: {
        updatedAt: note.updatedAt,
        blocks: [
          { index: 0, markdown: expect.stringContaining('Limits') },
          { index: 1, markdown: expect.stringContaining('derivative') },
        ],
      },
    });

    const patched = await call('update_note', {
      noteId: note.id,
      baseUpdatedAt: note.updatedAt,
      patches: [
        { index: 1, action: 'replace', markdown: 'A derivative is a local rate.' },
        { index: 2, action: 'insert', markdown: 'A final unchanged-size addition.' },
      ],
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const result = patched.value as Note;
    expect(result.doc.content[0]).toEqual(note.doc.content[0]);
    expect(result.plainText).toContain('A derivative is a local rate.');
    expect(result.plainText).toContain('A final unchanged-size addition.');
  });

  it('rejects a malformed create payload without writing a note', async () => {
    const result = await call('create_note', {
      markdown: 'one representation',
      doc: { type: 'doc', content: [] },
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await library.queryNotes({ scope: 'all' })).toHaveLength(0);
  });

  it('copies a long note exactly and prepends only newly generated Markdown', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const longBody = Array.from(
      { length: 2_000 },
      (_, index) => `Paragraph ${index}: evidence that must remain unchanged.`,
    ).join('\n\n');
    const updated = await call('update_note', {
      noteId: note.id,
      baseUpdatedAt: note.updatedAt,
      markdown: longBody,
    });
    if (!updated.ok) throw new Error(updated.message);
    const source = updated.value as Note;

    const copied = await call('create_note', {
      title: 'Lecture one — summary copy',
      copyFrom: { noteId: source.id, baseUpdatedAt: source.updatedAt },
      prependMarkdown: '## Summary\n\nA concise overview.',
    });

    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    const result = copied.value as Note;
    expect(result.courseId).toBe(source.courseId);
    expect(result.tagIds).toEqual(source.tagIds);
    expect(result.plainText).toContain('A concise overview.');
    expect(result.plainText).toContain(
      'Paragraph 1999: evidence that must remain unchanged.',
    );
    expect(result.doc.content.slice(-source.doc.content.length)).toEqual(
      source.doc.content,
    );
  });

  it('versions an update as agent work and rejects a stale retry', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const result = await call('update_note', {
      noteId: note.id,
      baseUpdatedAt: note.updatedAt,
      markdown: 'Revised by an agent.',
    });
    expect(result.ok).toBe(true);

    const snapshots = await library.listSnapshots(note.id);
    expect(snapshots.at(0)?.cause).toBe('agent');

    const stale = await call('update_note', {
      noteId: note.id,
      baseUpdatedAt: '2020-01-01T00:00:00.000Z',
      title: 'Should not land',
    });
    expect(stale).toMatchObject({ ok: false, code: 'conflict' });
    expect((await library.getNote(note.id))?.title).toBe('Lecture one');
  });

  it('prepends Markdown to a long note without replacing its source document', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const originalContent = note.doc.content;

    const result = await call('update_note', {
      noteId: note.id,
      baseUpdatedAt: note.updatedAt,
      prependMarkdown: '## Summary\n\nThe important result.',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.value as Note;
    expect(updated.plainText).toContain('The important result.');
    expect(updated.doc.content.slice(-originalContent.length)).toEqual(originalContent);
  });

  it('appends Markdown without making the caller resend the note', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');

    const result = await call('update_note', {
      noteId: note.id,
      baseUpdatedAt: note.updatedAt,
      appendMarkdown: '## Further reading\n\nChapter 3.',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.value as Note;
    expect(updated.doc.content.slice(0, note.doc.content.length)).toEqual(
      note.doc.content,
    );
    expect(updated.plainText).toContain('Chapter 3.');
  });

  it('moves notes to recoverable Trash, lists them there, and restores them', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');

    const trashed = await call('trash_notes', {
      notes: [{ noteId: note.id, baseUpdatedAt: note.updatedAt }],
    });
    expect(trashed).toMatchObject({ ok: true, value: { changed: 1, failed: [] } });
    expect((await library.getNote(note.id))?.trashedAt).toBeTruthy();

    const listed = await call('list_notes', { scope: 'trashed' });
    expect(listed).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: note.id, title: 'Lecture one' })],
    });

    const restored = await call('restore_notes', {
      notes: [{ noteId: note.id, baseUpdatedAt: note.updatedAt }],
    });
    expect(restored).toMatchObject({ ok: true, value: { changed: 1, failed: [] } });
    expect((await library.getNote(note.id))?.trashedAt).toBeNull();
  });

  it('merges in the requested order and only trashes sources after creating the result', async () => {
    const { course, note: first } = await createFixture();
    if (!first) throw new Error('fixture note missing');
    const secondResult = await call('create_note', {
      title: 'Lecture two',
      courseId: course.id,
      markdown: 'Continuity follows.',
    });
    if (!secondResult.ok) throw new Error(secondResult.message);
    const second = secondResult.value as NonNullable<
      Awaited<ReturnType<typeof library.getNote>>
    >;

    const merged = await call('merge_notes', {
      notes: [
        { noteId: second.id, baseUpdatedAt: second.updatedAt },
        { noteId: first.id, baseUpdatedAt: first.updatedAt },
      ],
      title: 'Combined lectures',
      sourceFate: 'trash',
    });
    expect(merged).toMatchObject({
      ok: true,
      value: expect.objectContaining({ title: 'Combined lectures', courseId: course.id }),
    });
    if (!merged.ok) return;
    const result = merged.value as NonNullable<
      Awaited<ReturnType<typeof library.getNote>>
    >;
    expect(result.plainText.indexOf('Lecture two')).toBeLessThan(
      result.plainText.indexOf('Lecture one'),
    );
    expect((await library.getNote(first.id))?.trashedAt).toBeTruthy();
    expect((await library.getNote(second.id))?.trashedAt).toBeTruthy();
  });

  it('refuses stale and permanently destructive note lifecycle requests', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    await expect(
      call('trash_notes', {
        notes: [{ noteId: note.id, baseUpdatedAt: '2020-01-01T00:00:00.000Z' }],
      }),
    ).resolves.toMatchObject({ ok: false, code: 'conflict' });
    expect((await library.getNote(note.id))?.trashedAt).toBeNull();
    expect(Object.keys(TOOL_HANDLERS)).not.toEqual(
      expect.arrayContaining(['empty_trash', 'purge_notes', 'delete_notes']),
    );
  });

  it('adds and renames tags through a versioned note update', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const current = await library.getNote(note.id);
    if (!current) throw new Error('fixture note missing');
    const existingTag = (await library.listTags())[0];
    if (!existingTag) throw new Error('fixture tag missing');

    const result = await call('manage_tags', {
      noteId: note.id,
      baseUpdatedAt: current.updatedAt,
      add: ['exam:midterm'],
      rename: [{ tagId: existingTag.id, name: 'analysis', namespace: 'topic' }],
    });
    expect(result.ok).toBe(true);
    expect(await library.listTags()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'analysis', namespace: 'topic' }),
        expect.objectContaining({ name: 'midterm', namespace: 'exam' }),
      ]),
    );
    expect((await library.listSnapshots(note.id)).at(0)?.cause).toBe('agent');
  });

  it('validates course creation', async () => {
    const result = await call('create_course', { name: '' });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('exports selected notes into the fixed managed Downloads folder', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const write = vi
      .spyOn(exporter, 'write')
      .mockResolvedValue({ ok: true, path: '/Downloads/NotaBene exports/lecture.md' });
    vi.spyOn(storage, 'exportsDir').mockResolvedValue('/Downloads/NotaBene exports');

    const result = await call('export_notes', {
      noteIds: [note.id],
      format: 'markdown',
      fileName: 'lecture.md',
      layout: 'combined',
      includeToc: false,
    });
    expect(result).toEqual({
      ok: true,
      value: '/Downloads/NotaBene exports/lecture.md',
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: '/Downloads/NotaBene exports/lecture.md',
      }),
    );
  });

  it('rejects the deprecated arbitrary destination and path-like file names', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const base = {
      noteIds: [note.id],
      format: 'markdown',
      layout: 'combined',
      includeToc: false,
    };

    await expect(
      call('export_notes', { ...base, destination: '/tmp/lecture.md' }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('fileName') });
    await expect(
      call('export_notes', { ...base, fileName: '../lecture.md' }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('separator'),
    });
  });

  it('creates sections and moves notes with a versioned organize call', async () => {
    const { course, note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const result = await call('organize', {
      createSection: { courseId: course.id, name: 'Revision' },
      moves: [
        {
          noteId: note.id,
          baseUpdatedAt: note.updatedAt,
          courseId: null,
          sectionId: null,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect((await library.getNote(note.id))?.courseId).toBeNull();
    expect(await library.listSections(course.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Revision' })]),
    );
    expect((await library.listSnapshots(note.id)).at(0)?.cause).toBe('agent');
  });
});

describe('Phase F activity accounting', () => {
  it('keeps the busy indicator on until concurrent requests have all finished', () => {
    const store = useMcpStore.getState();
    store.beginActivity({ id: 'one', method: 'read_note', args: {} });
    store.beginActivity({ id: 'two', method: 'search_notes', args: {} });
    expect(useUiStore.getState().agentBusy).toBe(true);

    useMcpStore.getState().finishActivity('one', { ok: true });
    expect(useUiStore.getState().agentBusy).toBe(true);

    useMcpStore.getState().finishActivity('two', { ok: false, error: 'failed' });
    expect(useUiStore.getState().agentBusy).toBe(false);
    expect(useMcpStore.getState().activities.map((entry) => entry.status)).toEqual([
      'failed',
      'succeeded',
    ]);
  });
});
