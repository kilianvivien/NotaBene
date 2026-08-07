import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '@/editor/markdown';
import type { RewriteProposal } from '@/lib/schema';
import { preservesText, wordDrift, words } from './reformat';

/** The shape `proposalFromResponse` produces, built here from Markdown so the
 * tests read as the edits a model would actually return. */
function edit(
  action: 'replace' | 'insert' | 'remove',
  markdown: string,
): RewriteProposal['blocks'][number] {
  const content = markdownToDoc(markdown).content;
  return {
    index: 0,
    action,
    node:
      action === 'remove'
        ? undefined
        : content.length === 1
          ? content[0]
          : { type: 'nb-fragment', content },
  };
}

describe('words', () => {
  it('sees through Markdown punctuation and case', () => {
    expect(words('## Photosynthesis')).toEqual(['photosynthesis']);
    expect(words('- **light** reactions')).toEqual(['light', 'reactions']);
    expect(words('1789: the Revolution')).toEqual(['1789', 'the', 'revolution']);
  });

  it('keeps accented letters whole', () => {
    expect(words('La Révolution française')).toEqual(['la', 'révolution', 'française']);
  });
});

describe('wordDrift', () => {
  it('reports nothing for a pure layout change', () => {
    expect(wordDrift('One two three', '- One\n- two\n- three')).toMatchObject({
      removed: 0,
      added: 0,
    });
  });

  it('counts a dropped word as removed', () => {
    expect(wordDrift('alpha beta gamma', 'alpha gamma').removed).toBe(1);
  });

  it('counts repeats rather than distinct words', () => {
    expect(wordDrift('beta beta beta', 'beta')).toMatchObject({ removed: 2, added: 0 });
  });

  it('counts an invented word as added', () => {
    expect(wordDrift('alpha beta', 'alpha beta gamma')).toMatchObject({
      removed: 0,
      added: 1,
    });
  });

  it('sees a substitution as both', () => {
    expect(wordDrift('the mitochondrion', 'the powerhouse')).toMatchObject({
      removed: 1,
      added: 1,
    });
  });
});

describe('preservesText', () => {
  const paragraph =
    'Photosynthesis converts light into chemical energy in the chloroplast.';

  it('accepts a line promoted to a heading', () => {
    expect(preservesText(edit('replace', '## Photosynthesis'), 'Photosynthesis')).toBe(
      true,
    );
  });

  it('accepts a wall of text split into a heading and paragraphs', () => {
    const laid = `## Photosynthesis\n\n${paragraph}`;
    expect(preservesText(edit('replace', laid), paragraph)).toBe(true);
  });

  it('rejects a reworded paragraph', () => {
    expect(
      preservesText(
        edit(
          'replace',
          'Photosynthesis turns sunlight into sugar inside the chloroplast.',
        ),
        paragraph,
      ),
    ).toBe(false);
  });

  it('rejects a summarised paragraph', () => {
    expect(preservesText(edit('replace', '## Photosynthesis'), paragraph)).toBe(false);
  });

  it('rejects a corrected spelling, however kindly meant', () => {
    expect(
      preservesText(
        edit('replace', 'The chloroplast absorbs light.'),
        'The chlorplast absorbs light.',
      ),
    ).toBe(false);
  });

  it('accepts an inserted heading', () => {
    expect(preservesText(edit('insert', '## Light reactions'), '')).toBe(true);
  });

  it('rejects an inserted paragraph', () => {
    expect(
      preservesText(edit('insert', 'A short introduction the model wrote.'), ''),
    ).toBe(false);
  });

  it('rejects an inserted heading long enough to be prose', () => {
    expect(
      preservesText(
        edit(
          'insert',
          '## In this section the author sets out at some length the case for the reforms',
        ),
        '',
      ),
    ).toBe(false);
  });

  it('never accepts a removal', () => {
    expect(preservesText(edit('remove', ''), paragraph)).toBe(false);
  });

  it('lets a long block carry more than one added heading', () => {
    const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
    const halves = long.split(' ');
    const laid = `## First half\n\n${halves.slice(0, 30).join(' ')}\n\n## Second half\n\n${halves
      .slice(30)
      .join(' ')}`;
    expect(preservesText(edit('replace', laid), long)).toBe(true);
  });
});
