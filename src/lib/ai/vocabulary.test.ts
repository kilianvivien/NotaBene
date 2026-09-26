import { describe, expect, it } from 'vitest';
import { proofreadPrompt, vocabularyPrompt } from './prompts';
import { excerptAround } from './vocabulary';

describe('vocabulary review request', () => {
  it('cuts an excerpt around a word on word boundaries', () => {
    const text =
      'Au début du cours, le professeur a présenté la mitochondrie comme la centrale énergétique de la cellule eucaryote.';
    const excerpt = excerptAround(text, 'mitochondrie', 60);
    expect(excerpt).toContain('mitochondrie');
    expect(excerpt.length).toBeLessThanOrEqual(60);
    expect(text).toContain(excerpt);
    expect(excerpt.startsWith(' ')).toBe(false);
  });

  it('sends words and excerpts, and the pasted material, but nothing else', () => {
    const [system, user] = vocabularyPrompt({
      courseName: 'Biologie "cellulaire"',
      candidates: [{ term: 'ribosomme', count: 4, context: 'le ribosomme traduit' }],
      material: 'Chapitre 2 : le ribosome',
      language: 'fr',
    });
    expect(system?.content).toContain('French');
    expect(user?.content).toContain('ribosomme (×4)');
    expect(user?.content).toContain('<material>');
    // Quotes in a course name cannot break out of the attribute.
    expect(user?.content).toContain(`name="Biologie 'cellulaire'"`);
  });

  it('tells the proofreader which course terms are already right', () => {
    const [, user] = proofreadPrompt({
      paragraph: 'La mitochondrie produit de l’ATP.',
      vocabulary: ['mitochondrie', 'ATP'],
      language: 'fr',
    });
    expect(user?.content).toContain('<vocabulary>mitochondrie, ATP</vocabulary>');
    expect(user?.content).toContain('<paragraph>');
  });
});
