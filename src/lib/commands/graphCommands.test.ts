import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ai from '@/lib/ai';
import * as aiCommands from './aiCommands';
import { DEFAULT_GRAPH_FILTERS } from '@/lib/graph/selection';
import { library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import type { DocNode, NoteDoc } from '@/lib/schema';
import {
  acceptSuggestedLinkCommand,
  appendSeeAlso,
  findMentionsCommand,
  linkFirstMention,
  linkMentionCommand,
  linkMentionsCommand,
  listUnlinkedMentionsCommand,
  readGraphCommand,
  suggestLinksCommand,
} from './graphCommands';
import { createNoteCommand, trashNoteCommand, updateNoteCommand } from './noteCommands';

function paragraph(...content: DocNode[]): NoteDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}
const text = (value: string, ...marks: string[]): DocNode => ({
  type: 'text',
  text: value,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const wiki = (noteId: string | null, title: string): DocNode => ({
  type: 'wikiLink',
  attrs: { noteId, title },
});

async function create(title: string, doc: NoteDoc, courseId: string | null = null) {
  const result = await createNoteCommand({ title, doc, courseId });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
});

afterEach(() => vi.restoreAllMocks());

describe('suggestLinksCommand', () => {
  it('honours the active course filter and includes title-only notes', async () => {
    vi.spyOn(aiCommands, 'providerFor').mockResolvedValue({
      ok: true,
      provider: {
        definition: ai.providerById('mistral')!,
        baseUrl: 'https://api.mistral.ai/v1',
        model: 'mistral-large-4',
        apiKey: null,
      },
    });
    const suggest = vi.spyOn(ai, 'requestLinkSuggestions').mockResolvedValue([]);
    const first = await create('Lecture outline', paragraph(), 'physics');
    const second = await create('Waves', paragraph(text('Wave motion.')), 'physics');
    await create('Shopping', paragraph(text('Milk.')), 'personal');
    const result = await suggestLinksCommand(
      {},
      { ...DEFAULT_GRAPH_FILTERS, course: 'course:physics' },
    );
    expect(result.ok && [result.value.considered, result.value.total]).toEqual([2, 2]);
    expect(suggest.mock.calls[0]![0].notes.map((note) => note.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it('returns a translated, actionable error for an invalid model response', async () => {
    vi.spyOn(aiCommands, 'providerFor').mockResolvedValue({
      ok: true,
      provider: {} as ai.ResolvedProvider,
    });
    await create('Waves', paragraph(text('Wave motion.')));
    await create('Damping', paragraph(text('Energy loss.')));
    vi.spyOn(ai, 'requestLinkSuggestions').mockRejectedValue(
      new ai.AiParseError('the model did not return JSON', 'prose'),
    );
    const result = await suggestLinksCommand();
    expect(!result.ok && result.message).toMatch(/Try again/);
    expect(!result.ok && result.code).toBe('invalid_input');
  });
});

describe('readGraphCommand', () => {
  it('returns live notes and the resolved links between them', async () => {
    const waves = await create('Waves', paragraph(text('Start here.')));
    const damping = await create(
      'Damping',
      // By id, by bare title, to itself, and to nothing: one edge.
      paragraph(
        wiki(waves.id, 'Waves'),
        wiki(null, 'waves'),
        wiki(null, 'Damping'),
        wiki(null, 'Nowhere'),
      ),
    );
    const binned = await create('Binned', paragraph(wiki(waves.id, 'Waves')));
    await trashNoteCommand(binned.id);
    const shelved = await create('Shelved', paragraph(wiki(waves.id, 'Waves')));
    await updateNoteCommand({ noteId: shelved.id, archived: true });

    const graph = await readGraphCommand({ mentions: false });
    if (!graph.ok) throw new Error(graph.message);
    expect(graph.value.nodes.map((node) => node.id).sort()).toEqual(
      [waves.id, damping.id].sort(),
    );
    expect(graph.value.edges).toEqual([{ sourceId: damping.id, targetId: waves.id }]);
    expect(graph.value.mentions).toEqual([]);
  });

  it('adds unlinked mentions only when asked, and never for a note already linked', async () => {
    const damping = await create('Damping', paragraph(text('The target.')));
    const mentions = await create('Week 4', paragraph(text('We saw DAMPING today.')));
    await create('Week 5', paragraph(text('Overdamping is another word.')));
    await create(
      'Week 6',
      paragraph(text('More on damping: '), wiki(damping.id, 'Damping')),
    );

    const graph = await readGraphCommand({ mentions: true });
    if (!graph.ok) throw new Error(graph.message);
    expect(graph.value.mentions).toEqual([
      { sourceId: mentions.id, targetId: damping.id },
    ]);

    const listed = await listUnlinkedMentionsCommand(damping.id);
    if (!listed.ok) throw new Error(listed.message);
    expect(listed.value.map((mention) => mention.sourceId)).toEqual([mentions.id]);
    expect(listed.value[0]!.snippet).toContain('DAMPING');
  });

  it('gives a duplicate title to the note a bare link would reach', async () => {
    const first = await create('Entropy', paragraph(text('The original.')));
    const second = await create('entropy', paragraph(text('A later duplicate.')));
    await create('Week 9', paragraph(text('Entropy always rises.')));

    const forFirst = await listUnlinkedMentionsCommand(first.id);
    const forSecond = await listUnlinkedMentionsCommand(second.id);
    expect(forFirst.ok && forFirst.value).toHaveLength(1);
    expect(forSecond.ok && forSecond.value).toEqual([]);
  });
});

describe('linkFirstMention', () => {
  const target = { id: 'n_damping', title: 'Damping' };

  it('splits the text node around a link and keeps its marks', () => {
    const doc = linkFirstMention(
      paragraph(text('We saw damping today.', 'italic')),
      target,
    );
    expect(doc?.content[0]!.content).toEqual([
      text('We saw ', 'italic'),
      {
        type: 'wikiLink',
        attrs: { noteId: 'n_damping', title: 'Damping', label: 'damping' },
      },
      text(' today.', 'italic'),
    ]);
  });

  it('writes no label when the text already reads as the title', () => {
    const doc = linkFirstMention(paragraph(text('Damping')), target);
    expect(doc?.content[0]!.content).toEqual([
      { type: 'wikiLink', attrs: { noteId: 'n_damping', title: 'Damping', label: null } },
    ]);
  });

  it('links only the first mention', () => {
    const doc = linkFirstMention(paragraph(text('damping, then damping again')), target);
    const kinds = doc?.content[0]!.content!.map((node) => node.type);
    expect(kinds).toEqual(['wikiLink', 'text']);
  });

  it('leaves code and web links alone, and reports a mention it cannot place', () => {
    expect(linkFirstMention(paragraph(text('damping', 'code')), target)).toBeNull();
    expect(linkFirstMention(paragraph(text('damping', 'link')), target)).toBeNull();
    expect(
      linkFirstMention(
        { type: 'doc', content: [{ type: 'codeBlock', content: [text('damping')] }] },
        target,
      ),
    ).toBeNull();
    // Half bold: in the plain text, but not in any one node.
    expect(
      linkFirstMention(paragraph(text('damp', 'bold'), text('ing')), target),
    ).toBeNull();
  });
});

describe('linkMentionCommand', () => {
  it('turns the mention into a backlink and keeps the version before it', async () => {
    const damping = await create('Damping', paragraph(text('The target.')));
    const week = await create('Week 4', paragraph(text('We saw damping today.')));

    const result = await linkMentionCommand({ sourceId: week.id, targetId: damping.id });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.plainText).toBe('We saw  today.');

    expect(
      (await library.listBacklinks(damping.id)).map((link) => link.sourceId),
    ).toEqual([week.id]);
    expect(await library.listUnlinkedMentions(damping.id)).toEqual([]);
    const versions = await library.listSnapshots(week.id);
    expect(versions).toHaveLength(1);
  });

  it('refuses a mention split across formatting instead of guessing', async () => {
    const damping = await create('Damping', paragraph(text('The target.')));
    const week = await create(
      'Week 4',
      paragraph(text('damp', 'bold'), text('ing today')),
    );
    const result = await linkMentionCommand({ sourceId: week.id, targetId: damping.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_supported');
    expect((await library.getNote(week.id))!.updatedAt).toBe(week.updatedAt);
  });

  it('refuses a note that is gone, and a note linking to itself', async () => {
    const damping = await create('Damping', paragraph(text('damping')));
    const missing = await linkMentionCommand({ sourceId: 'nope', targetId: damping.id });
    expect(!missing.ok && missing.code).toBe('not_found');
    const self = await linkMentionCommand({ sourceId: damping.id, targetId: damping.id });
    expect(!self.ok && self.code).toBe('invalid_input');
  });
});

describe('findMentionsCommand', () => {
  it('lists mentions with titles and the token needed to link them', async () => {
    const damping = await create('Damping', paragraph(text('The target.')));
    const week = await create(
      'Week 4',
      paragraph(text('We saw damping today.')),
      'physics',
    );
    await create('Week 5', paragraph(text('More damping.')), 'maths');

    const all = await findMentionsCommand();
    if (!all.ok) throw new Error(all.message);
    expect(all.value.total).toBe(2);
    expect(all.value.mentions).toContainEqual({
      sourceId: week.id,
      sourceTitle: 'Week 4',
      sourceUpdatedAt: week.updatedAt,
      targetId: damping.id,
      targetTitle: 'Damping',
    });

    const physics = await findMentionsCommand({ courseId: 'physics' });
    expect(physics.ok && physics.value.mentions.map((m) => m.sourceId)).toEqual([
      week.id,
    ]);
    const byNote = await findMentionsCommand({ noteIds: [damping.id] });
    expect(byNote.ok && byNote.value.total).toBe(2);
    const capped = await findMentionsCommand({ limit: 1 });
    expect(capped.ok && [capped.value.mentions.length, capped.value.total]).toEqual([
      1, 2,
    ]);
  });
});

describe('linkMentionsCommand', () => {
  it('writes a note once however many links it gains', async () => {
    const damping = await create('Damping', paragraph(text('The target.')));
    const resonance = await create('Resonance', paragraph(text('Another target.')));
    const week = await create(
      'Week 4',
      paragraph(text('We saw damping and then resonance today.')),
    );

    const result = await linkMentionsCommand([
      { sourceId: week.id, targetId: damping.id, baseUpdatedAt: week.updatedAt },
      { sourceId: week.id, targetId: resonance.id, baseUpdatedAt: week.updatedAt },
    ]);
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toEqual({ linked: 2, notes: 1, skipped: [] });
    expect(await library.listSnapshots(week.id)).toHaveLength(1);
    expect((await library.listBacklinks(damping.id)).map((l) => l.sourceId)).toEqual([
      week.id,
    ]);
    expect((await library.listBacklinks(resonance.id)).map((l) => l.sourceId)).toEqual([
      week.id,
    ]);
  });

  it('skips what it cannot place and links the rest', async () => {
    const damping = await create('Damping', paragraph(text('The target.')));
    const split = await create(
      'Week 4',
      paragraph(text('damp', 'bold'), text('ing today')),
    );
    const fine = await create('Week 5', paragraph(text('More damping.')));

    const result = await linkMentionsCommand([
      { sourceId: split.id, targetId: damping.id, baseUpdatedAt: split.updatedAt },
      { sourceId: fine.id, targetId: damping.id, baseUpdatedAt: fine.updatedAt },
      { sourceId: 'gone', targetId: damping.id },
    ]);
    if (!result.ok) throw new Error(result.message);
    expect(result.value.linked).toBe(1);
    expect(result.value.skipped).toEqual([
      { sourceId: 'gone', targetId: damping.id, reason: 'not_found' },
      { sourceId: split.id, targetId: damping.id, reason: 'not_in_one_run' },
    ]);
    expect((await library.getNote(split.id))!.updatedAt).toBe(split.updatedAt);
  });

  it('refuses the whole call when one note changed since it was read', async () => {
    const damping = await create('Damping', paragraph(text('The target.')));
    const fresh = await create('Week 4', paragraph(text('We saw damping.')));
    const stale = await create('Week 5', paragraph(text('More damping.')));

    const result = await linkMentionsCommand([
      { sourceId: fresh.id, targetId: damping.id, baseUpdatedAt: fresh.updatedAt },
      {
        sourceId: stale.id,
        targetId: damping.id,
        baseUpdatedAt: '2020-01-01T00:00:00.000Z',
      },
    ]);
    expect(!result.ok && result.code).toBe('conflict');
    // Nothing was written — not even the note whose token was good.
    expect(await library.listBacklinks(damping.id)).toEqual([]);
  });
});

describe('appendSeeAlso', () => {
  const damping = { id: 'n_damping', title: 'Damping' };
  const resonance = { id: 'n_resonance', title: 'Resonance' };
  const link = (target: { id: string; title: string }) => ({
    type: 'wikiLink',
    attrs: { noteId: target.id, title: target.title, label: null },
  });

  it('adds a see-also line at the foot of the note', () => {
    const doc = appendSeeAlso(paragraph(text('Body.')), damping, 'See also:');
    expect(doc.content).toHaveLength(2);
    expect(doc.content[1]).toEqual({
      type: 'paragraph',
      content: [text('See also: '), link(damping)],
    });
  });

  it('extends the line that is already there instead of adding another', () => {
    const once = appendSeeAlso(paragraph(text('Body.')), damping, 'See also:');
    const twice = appendSeeAlso(once, resonance, 'See also:');
    expect(twice.content).toHaveLength(2);
    expect(twice.content[1]!.content).toEqual([
      text('See also: '),
      link(damping),
      text(', '),
      link(resonance),
    ]);
  });
});

describe('acceptSuggestedLinkCommand', () => {
  it('writes the link as an AI edit, with the version before it kept', async () => {
    const damping = await create('Damping', paragraph(text('The target.')));
    const week = await create('Week 4', paragraph(text('Nothing names it here.')));

    const result = await acceptSuggestedLinkCommand({
      sourceId: week.id,
      targetId: damping.id,
      label: 'See also:',
    });
    if (!result.ok) throw new Error(result.message);
    expect((await library.listBacklinks(damping.id)).map((l) => l.sourceId)).toEqual([
      week.id,
    ]);
    const versions = await library.listSnapshots(week.id);
    expect(versions.map((version) => version.cause)).toEqual(['ai']);
  });

  it('refuses a note that is gone, and a note linking to itself', async () => {
    const damping = await create('Damping', paragraph(text('x')));
    const self = await acceptSuggestedLinkCommand({
      sourceId: damping.id,
      targetId: damping.id,
      label: 'See also:',
    });
    expect(!self.ok && self.code).toBe('invalid_input');
    const gone = await acceptSuggestedLinkCommand({
      sourceId: 'nope',
      targetId: damping.id,
      label: 'See also:',
    });
    expect(!gone.ok && gone.code).toBe('not_found');
  });
});
