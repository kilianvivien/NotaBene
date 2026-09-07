import { describe, expect, it } from 'vitest';
import { AiDefinitionResponseSchema } from '@/lib/schema';
import { clampContext, MAX_CONTEXT_CHARS } from './define';
import { definitionPrompt } from './prompts';

describe('clampContext', () => {
  it('leaves a passage that already fits', () => {
    expect(clampContext('  Un raisonnement déductif.  ')).toBe(
      'Un raisonnement déductif.',
    );
  });

  it('cuts a long passage on a word boundary', () => {
    const clamped = clampContext(`${'mot '.repeat(600)}fin`);

    expect(clamped.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(clamped.endsWith('mot')).toBe(true);
  });

  /** A block with no spaces in it — a formula, a URL — has no boundary to cut
   * on, and must still be cut rather than sent whole. */
  it('cuts a passage with no word boundary at all', () => {
    expect(clampContext('x'.repeat(MAX_CONTEXT_CHARS * 2)).length).toBe(
      MAX_CONTEXT_CHARS,
    );
  });
});

describe('definitionPrompt', () => {
  it('sends the passage with the term, so the sense can be settled', () => {
    const [, user] = definitionPrompt({
      term: 'prime',
      context: 'Un nombre premier n’a que deux diviseurs.',
      noteTitle: 'Arithmétique',
      language: 'fr',
    });

    expect(user?.content).toContain('<term>prime</term>');
    expect(user?.content).toContain('deux diviseurs');
    expect(user?.content).toContain('Arithmétique');
  });

  it('asks for the answer in the app language', () => {
    const [system] = definitionPrompt({
      term: 'prime',
      context: '',
      noteTitle: '',
      language: 'fr',
    });

    expect(system?.content).toContain('Answer in French');
  });

  /** A term typed into the dialog has no passage. The note element would be
   * empty, and an empty one invites the model to define the word by it. */
  it('omits the note element when there is no passage', () => {
    const [, user] = definitionPrompt({
      term: 'prime',
      context: '   ',
      noteTitle: 'Arithmétique',
      language: 'en',
    });

    expect(user?.content).toBe('<term>prime</term>');
  });
});

describe('AiDefinitionResponseSchema', () => {
  it('accepts an answer that omits the optional fields', () => {
    const parsed = AiDefinitionResponseSchema.parse({
      term: 'syllogisme',
      definition: 'Un raisonnement déductif.',
    });

    // A small model that never heard of the field must not have its answer
    // read as a warning it did not give.
    expect(parsed.uncertain).toBe(false);
    expect(parsed.inContext).toBeUndefined();
  });

  it('keeps a warning the model did give', () => {
    const parsed = AiDefinitionResponseSchema.parse({
      term: 'zzz',
      definition: 'Peut-être un acronyme.',
      uncertain: true,
    });

    expect(parsed.uncertain).toBe(true);
  });

  it('rejects an answer with no definition in it', () => {
    expect(
      AiDefinitionResponseSchema.safeParse({ term: 'syllogisme', definition: '   ' })
        .success,
    ).toBe(false);
  });
});
