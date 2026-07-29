import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exporter, library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createCourseCommand, createSectionCommand } from '@/lib/commands';
import { TOOL_HANDLERS } from '@/lib/mcp/toolHandlers';
import { useMcpStore } from '@/lib/state/mcpStore';
import { useUiStore } from '@/lib/state/uiStore';
import type { CommandContext, CommandResult } from '@/lib/commands';

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
    if (result.ok) expect(result.value).toMatchObject({ appVersion: '0.4.0' });
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

  it('rejects a malformed create payload without writing a note', async () => {
    const result = await call('create_note', {
      markdown: 'one representation',
      doc: { type: 'doc', content: [] },
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await library.queryNotes({ scope: 'all' })).toHaveLength(0);
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

  it('exports selected notes to the caller-provided destination', async () => {
    const { note } = await createFixture();
    if (!note) throw new Error('fixture note missing');
    const write = vi
      .spyOn(exporter, 'write')
      .mockResolvedValue({ ok: true, path: '/tmp/lecture.md' });

    const result = await call('export_notes', {
      noteIds: [note.id],
      format: 'markdown',
      destination: '/tmp/lecture.md',
      layout: 'combined',
      includeToc: false,
    });
    expect(result).toEqual({ ok: true, value: '/tmp/lecture.md' });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ destination: '/tmp/lecture.md' }),
    );
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
