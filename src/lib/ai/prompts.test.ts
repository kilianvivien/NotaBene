import { describe, expect, it } from 'vitest';
import {
  askPrompt,
  diagramPrompt,
  mermaidRepairPrompt,
  reformatPrompt,
  rewritePrompt,
  synthesisPrompt,
} from './prompts';

describe('Import reformatting prompt', () => {
  const prompt = reformatPrompt({
    blocks: ['Photosynthesis', 'It happens in the leaf.'],
  });

  it('numbers the blocks it asks about', () => {
    expect(prompt[1]?.content).toContain('<block index="0">\nPhotosynthesis\n</block>');
    expect(prompt[1]?.content).toContain('<block index="1">');
  });

  it('forbids the edits that would make it a rewrite', () => {
    const content = prompt[0]?.content ?? '';
    expect(content).toContain("Never change the document's text");
    expect(content).toContain('"remove" is never valid here');
    expect(content).toContain('may only ever be a heading');
  });

  it('leaves the language to the document rather than the locale', () => {
    const content = prompt[0]?.content ?? '';
    expect(content).toContain('Write it in the language the document is written in');
    expect(content).not.toContain('Answer in English');
  });
});

describe('Rewrite study mode', () => {
  function intent(mode: 'light' | 'full' | 'study'): string {
    return (
      rewritePrompt({
        mode,
        blocks: ['Photosynthesis', 'It happens in the leaf.'],
        language: 'en',
      })[1]?.content ?? ''
    );
  }

  it('asks for revision notes rather than a tidier version of the same prose', () => {
    const content = intent('study');
    expect(content).toContain('revision notes');
    expect(content).toContain('Compress freely');
  });

  it('forbids invention, which is the one thing that would make it useless', () => {
    // A model asked to make something memorable reaches for a tidy example.
    // An invented example in revision material is worse than no revision
    // material, because it is indistinguishable from the real ones.
    const content = intent('study');
    expect(content).toContain('Invent nothing');
    expect(content).toContain('no facts you happen to know about the subject');
  });

  it('still requires every fact in the source to survive', () => {
    expect(intent('study')).toContain('must survive somewhere');
  });

  it('is a different instruction from a full rewrite, not a louder one', () => {
    // The two are adjacent in the picker; if they asked for the same thing
    // there would be no reason for the fourth segment to exist.
    expect(intent('study')).not.toEqual(intent('full'));
    expect(intent('full')).not.toContain('revision notes');
  });

  it('keeps the conservative system prompt every mode shares', () => {
    // The per-block gate and the "these are someone's revision materials
    // before an exam" framing are not relaxed for this mode.
    const system =
      rewritePrompt({ mode: 'study', blocks: ['A'], language: 'en' })[0]?.content ?? '';
    expect(system).toContain('careful and conservative');
    expect(system).toContain('Return only the blocks you want to change.');
  });
});

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
      expect(content).toContain(
        'Do not conclude that the user has no notes on the topic',
      );
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

describe('Diagram prompt', () => {
  const prompt = diagramPrompt({
    title: 'Cellular respiration',
    markdown: '# Glycolysis\n\nGlucose becomes pyruvate.',
    language: 'en',
  });

  /**
   * The constraint the whole feature rests on. Only these three convert to
   * Excalidraw elements; anything else is rasterised into the scene and stops
   * being editable, which is the reason for routing through Excalidraw at all.
   */
  it('confines the model to the kinds that stay editable', () => {
    const content = prompt[0]?.content ?? '';
    expect(content).toContain('"flowchart"');
    expect(content).toContain('"sequence"');
    expect(content).not.toContain('"class"');
    expect(content).toContain('Use no other Mermaid diagram type');
  });

  it('asks for relations rather than the outline the student already has', () => {
    const content = prompt[0]?.content ?? '';
    expect(content).toContain('relations');
    expect(content).toContain('A box per heading');
  });

  it('refuses a code fence, which would break the parser downstream', () => {
    expect(prompt[0]?.content).toContain('Do not wrap it in a code fence');
  });

  it('passes the note through with its title', () => {
    expect(prompt[1]?.content).toContain('<note title="Cellular respiration">');
    expect(prompt[1]?.content).toContain('Glucose becomes pyruvate.');
  });
});

describe('Mermaid repair prompt', () => {
  const previous = diagramPrompt({ title: 'T', markdown: 'body', language: 'en' });
  const repair = mermaidRepairPrompt(
    previous,
    '{"kind":"flowchart"}',
    'Parse error on line 2',
  );

  it('keeps the original exchange so the model can see what it was asked', () => {
    expect(repair.slice(0, previous.length)).toEqual(previous);
  });

  it('shows the model its own answer and names the parser error', () => {
    expect(repair.at(-2)).toEqual({
      role: 'assistant',
      content: '{"kind":"flowchart"}',
    });
    expect(repair.at(-1)?.content).toContain('Parse error on line 2');
  });
});
