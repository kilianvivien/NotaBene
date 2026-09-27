import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc } from './index';

function firstInline(markdown: string, options?: Parameters<typeof markdownToDoc>[1]) {
  return markdownToDoc(markdown, options).content[0]?.content?.[0];
}

describe('wiki link dialects', () => {
  it('keeps NotaBene’s own [[Title|id]] id-backed by default', () => {
    expect(firstInline('[[Week 4|abcdefghijk]]')?.attrs).toEqual({
      title: 'Week 4',
      noteId: 'abcdefghijk',
    });
  });

  it('reads the pipe as an alias in the Obsidian dialect, dropping folder and heading', () => {
    expect(
      firstInline('[[Physics/Week 4#Damping|damping]]', { wikiLinks: 'obsidian' })?.attrs,
    ).toEqual({ title: 'Week 4', noteId: null, label: 'damping' });
  });

  it('lets the importer resolve the target to a note of the batch', () => {
    const node = firstInline('[[Physics/Week 4]]', {
      wikiLinks: 'obsidian',
      resolveWikiLink: (target) => ({ title: `${target}!`, noteId: 'note-1' }),
    });
    expect(node?.attrs).toEqual({ title: 'Physics/Week 4!', noteId: 'note-1' });
  });

  it('turns a link to a heading in the same note into text', () => {
    expect(firstInline('[[#Damping]]', { wikiLinks: 'obsidian' })).toEqual({
      type: 'text',
      text: 'Damping',
    });
  });

  it('writes an aliased link back out by title and id — the alias is presentation', () => {
    const doc = markdownToDoc('[[Week 4|damping]]', {
      wikiLinks: 'obsidian',
      resolveWikiLink: () => ({ title: 'Week 4', noteId: 'note-1' }),
    });
    expect(docToMarkdown(doc)).toBe('[[Week 4|note-1]]');
  });
});
