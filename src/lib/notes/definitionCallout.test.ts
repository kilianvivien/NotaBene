import { describe, expect, it } from 'vitest';
import { docToMarkdown } from '@/editor/markdown';
import { definitionCallout } from './definitionCallout';

const DEFINITION = {
  term: 'syllogisme',
  definition: 'Un raisonnement déductif à deux prémisses et une conclusion.',
  uncertain: false,
};

describe('definitionCallout', () => {
  it('leads with the headword in bold, then the definition', () => {
    const node = definitionCallout(DEFINITION);

    expect(node.type).toBe('callout');
    expect(node.attrs).toEqual({ kind: 'info' });
    const paragraph = node.content?.[0];
    expect(paragraph?.content?.[0]).toEqual({
      type: 'text',
      text: 'syllogisme',
      marks: [{ type: 'bold' }],
    });
    expect(paragraph?.content?.at(-1)?.text).toBe(DEFINITION.definition);
  });

  it('keeps the note-specific sense as its own paragraph', () => {
    const node = definitionCallout({
      ...DEFINITION,
      inContext: '  Ici, au sens logique.  ',
    });

    expect(node.content).toHaveLength(2);
    expect(node.content?.[1]?.content?.[0]).toEqual({
      type: 'text',
      text: 'Ici, au sens logique.',
      marks: [{ type: 'italic' }],
    });
  });

  it('adds nothing when the model sent no context sentence', () => {
    expect(definitionCallout({ ...DEFINITION, inContext: '   ' }).content).toHaveLength(
      1,
    );
  });

  /** The point of reusing the callout: it is already something every export
   * path writes. A definition that did not survive `docToMarkdown` would not
   * survive an export either. */
  it('serialises as a callout the Markdown dialect already round-trips', () => {
    const markdown = docToMarkdown({
      type: 'doc',
      content: [definitionCallout({ ...DEFINITION, inContext: 'Sens logique.' })],
    });

    expect(markdown).toContain('> [!INFO]');
    expect(markdown).toContain('**syllogisme**');
    expect(markdown).toContain('*Sens logique.*');
  });
});
