import { describe, expect, it } from 'vitest';
import { synthesisPrompt } from './prompts';

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
