import { describe, expect, it } from 'vitest';
import { askPrompt, synthesisPrompt } from './prompts';

describe('Q&A synthesis prompt', () => {
  it('asks for a French answer label in French', () => {
    const prompt = synthesisPrompt({
      style: 'qa',
      sources: [{ title: 'Cours', markdown: 'Contenu' }],
      language: 'fr',
    });

    expect(prompt[1]?.content).toContain('> [!TOGGLE Réponse]');
    expect(prompt[1]?.content).not.toContain('> [!TOGGLE Answer]');
  });

  it('keeps the English answer label in English', () => {
    const prompt = synthesisPrompt({
      style: 'qa',
      sources: [{ title: 'Lecture', markdown: 'Content' }],
      language: 'en',
    });

    expect(prompt[1]?.content).toContain('> [!TOGGLE Answer]');
  });
});

describe('Ask prompt grounding modes', () => {
  const base = {
    scope: 'note' as const,
    sources: [{ title: 'Lecture', markdown: 'The note says only this.' }],
    history: [],
    question: 'What else is relevant?',
    language: 'en',
  };

  it('forbids outside facts and treats history only as conversational context in note-only mode', () => {
    const prompt = askPrompt({ ...base, mode: 'note' });

    expect(prompt[0]?.content).toContain(
      'The notes are the only allowed source of factual information',
    );
    expect(prompt[0]?.content).toContain(
      'Use the conversation history only to understand what the user is referring to',
    );
    expect(prompt[0]?.content).toContain('Do not use general knowledge');
    expect(prompt[0]?.content).toContain('Do not fill the gap');
  });

  it('allows clearly labelled model knowledge in knowledge mode', () => {
    const prompt = askPrompt({ ...base, mode: 'knowledge' });

    expect(prompt[0]?.content).toContain('You may then add what you know');
    expect(prompt[0]?.content).toContain('label it clearly as outside the notes');
    expect(prompt[0]?.content).not.toContain(
      'The notes are the only allowed source of factual information',
    );
  });
});

describe('Ask prompt scope rules', () => {
  const base = {
    mode: 'note' as const,
    sources: [{ title: 'Lecture', markdown: 'The note says only this.' }],
    history: [],
    question: 'Where was this defined?',
    language: 'en',
  };

  it('says nothing about search at note scope, where silence really is absence', () => {
    const prompt = askPrompt({ ...base, scope: 'note' });
    expect(prompt[0]?.content).not.toContain('keyword search');
    expect(prompt[0]?.content).not.toContain('may not have been found');
  });

  for (const scope of ['course', 'library'] as const) {
    it(`warns that the search can miss at ${scope} scope`, () => {
      const prompt = askPrompt({ ...base, scope });
      const content = prompt[0]?.content ?? '';
      expect(content).toContain('the ones a keyword search found');
      expect(content).toContain('not the whole library');
      // The failure this exists to prevent: reporting a retrieval miss as an
      // absence in the student's own library.
      expect(content).toContain('Do not conclude that the user has no notes on the topic');
      expect(content).toContain('Cite notes by their title, never by index number');
    });
  }

  it('explains a truncated note only when one was sent', () => {
    const whole = askPrompt({ ...base, scope: 'library' });
    expect(whole[0]?.content).not.toContain('marked truncated');

    const windowed = askPrompt({
      ...base,
      scope: 'library',
      sources: [{ title: 'Long', markdown: 'part of it', truncated: true }],
    });
    expect(windowed[0]?.content).toContain('marked truncated');
    expect(windowed[0]?.content).toContain('truncated="true"');
  });
});
