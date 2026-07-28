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
    expect(prompt[0]?.content).toContain('label it clearly as outside the note');
    expect(prompt[0]?.content).not.toContain(
      'The notes are the only allowed source of factual information',
    );
  });
});
