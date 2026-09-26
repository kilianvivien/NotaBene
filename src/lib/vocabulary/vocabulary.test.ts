import { describe, expect, it } from 'vitest';
import type { NoteText } from '@/lib/adapters';
import { buildCompletionIndex, rankCompletions } from './completionIndex';
import { buildNoteIndex } from './noteWords';
import { PRESENCE_PROFILES } from './presence';
import { createHarvester, harvestVocabulary } from './harvest';
import { adaptCase, codePointLength, foldKey, wordAtEnd, wordsIn } from './text';

function note(id: string, plainText: string, title = ''): NoteText {
  return { id, title, plainText };
}

describe('folding', () => {
  it('ignores accents and case', () => {
    expect(foldKey('Théorème')).toBe('theoreme');
    expect(foldKey('ŒUVRE')).toBe('œuvre');
  });

  /** The ghost text is cut off the term by position, so a folded prefix must
   * be exactly as long as what the student typed. */
  it('keeps the length of what it folds, decomposed input included', () => {
    for (const word of ['élément', 'élément', 'İstanbul', 'straße', 'Ångström']) {
      expect(codePointLength(foldKey(word))).toBe(codePointLength(word.normalize('NFC')));
    }
  });
});

describe('words', () => {
  it('splits an elided article off and keeps hyphenated words whole', () => {
    expect(wordsIn("l'enzyme du laissez-faire, 2026")).toEqual([
      'l',
      'enzyme',
      'du',
      'laissez-faire',
      '2026',
    ]);
  });

  it('finds the word being typed, trailing hyphen included', () => {
    expect(wordAtEnd('La mitoch')).toBe('mitoch');
    expect(wordAtEnd('du laissez-')).toBe('laissez-');
    expect(wordAtEnd('fin. ')).toBe('');
  });
});

describe('casing a completion', () => {
  it('follows a capital typed at the start of a sentence', () => {
    expect(adaptCase('mitochondrie', 'Mito')).toBe('Mitochondrie');
  });

  it('continues a word typed in capitals', () => {
    expect(adaptCase('mitochondrie', 'MITO')).toBe('MITOCHONDRIE');
  });

  it('keeps the capitals of a proper noun or an acronym', () => {
    expect(adaptCase('Schrödinger', 'schr')).toBe('Schrödinger');
  });
});

describe('harvest', () => {
  it('keeps words that recur, and drops one-off words as possible typos', () => {
    const terms = harvestVocabulary([
      note('1', 'La mitochondrie produit énergie. Mitochondrie encore.'),
      note('2', 'Une mitochondrie. Une seule fois: ribosomme.'),
    ]).map((term) => term.term);
    expect(terms).toContain('mitochondrie');
    expect(terms).not.toContain('ribosomme');
  });

  it('prefers the lower-case spelling over one capitalised by a sentence', () => {
    const [term] = harvestVocabulary([
      note('1', 'Photosynthèse. La photosynthèse.'),
      note('2', 'Photosynthèse et photosynthèse.'),
    ]);
    expect(term?.term).toBe('photosynthèse');
  });

  it('prefers the accented spelling of the same word at equal use', () => {
    const [term] = harvestVocabulary([
      note('1', 'element élément'),
      note('2', 'element élément'),
    ]);
    expect(term?.term).toBe('élément');
  });

  it('leaves out short words and everyday connectives', () => {
    const keys = harvestVocabulary([
      note('1', 'également cellule également cellule'),
      note('2', 'également cellule'),
    ]).map((term) => term.key);
    expect(keys).toContain('cellule');
    expect(keys).not.toContain('egalement');
  });

  it('keeps a tag name even before any note uses it', () => {
    const terms = harvestVocabulary([], { keyTerms: ['thermodynamique'] });
    expect(terms.map((term) => term.term)).toEqual(['thermodynamique']);
  });

  /**
   * The cache feeds notes in one at a time and yields between slices, so what
   * has to stay small is the cost of one note — that is what could hold up a
   * keystroke. The total only has to be reasonable.
   */
  it('harvests a large course without any single note holding the thread', () => {
    const vocabulary = Array.from({ length: 800 }, (_, index) => `terme${index}ation`);
    const body = Array.from(
      { length: 3_000 },
      (_, index) => `${vocabulary[index % vocabulary.length]} et le`,
    ).join(' ');
    const harvester = createHarvester();
    let slowest = 0;
    const started = performance.now();
    for (let index = 0; index < 200; index += 1) {
      const before = performance.now();
      harvester.add(note(String(index), body));
      slowest = Math.max(slowest, performance.now() - before);
    }
    const terms = harvester.finish();
    const total = performance.now() - started;
    expect(terms.length).toBe(800);
    // ~20 KB per note. Loose ceilings, so a busy CI runner does not fail a
    // correct build; on a laptop both are several times lower.
    expect(slowest).toBeLessThan(50);
    expect(total).toBeLessThan(2_000);
  });
});

describe('completion index', () => {
  const harvested = harvestVocabulary([
    note('1', 'théorème cellule cellulaire cellule mitochondrie'),
    note('2', 'théorème cellule cellulaire mitochondrie'),
  ]);

  it('finds a term from an unaccented prefix and gives back its accents', () => {
    expect(buildCompletionIndex(harvested, []).complete('theor')?.term).toBe('théorème');
  });

  it('prefers the more used term, and the shorter one on a tie', () => {
    const index = buildCompletionIndex(harvested, []);
    expect(index.complete('cell')?.term).toBe('cellule');
  });

  it('never offers a word the student has silenced', () => {
    const index = buildCompletionIndex(harvested, [
      { term: 'mitochondrie', status: 'rejected' },
    ]);
    expect(index.complete('mito')).toBeNull();
    expect(index.isRejected('Mitochondrie')).toBe(true);
  });

  it('puts the student’s own words first, in their spelling', () => {
    const index = buildCompletionIndex(harvested, [
      { term: 'cellulaire', status: 'accepted' },
      { term: 'Schrödinger', status: 'accepted' },
    ]);
    expect(index.complete('cell')?.term).toBe('cellulaire');
    expect(index.complete('schro')?.term).toBe('Schrödinger');
  });

  it('suggests nothing for a word that is already complete', () => {
    expect(buildCompletionIndex(harvested, []).complete('cellule')).toBeNull();
  });

  it('answers a keystroke in well under a millisecond at full size', () => {
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
      term: `vocabulaire${index}`,
      key: `vocabulaire${index}`,
      count: index,
      notes: 1,
      score: index,
    }));
    const index = buildCompletionIndex(entries, []);
    const started = performance.now();
    for (let round = 0; round < 1_000; round += 1) index.complete('vocab');
    const perLookup = (performance.now() - started) / 1_000;
    expect(perLookup).toBeLessThan(0.5);
  });
});

describe('ranking across sources', () => {
  const course = buildCompletionIndex(
    harvestVocabulary([
      note('1', 'cellule cellule cellulaire'),
      note('2', 'cellule cellulaire'),
    ]),
    [{ term: 'celluloïd', status: 'rejected' }],
  );

  it('lets the open note lift a word the course ranks lower', () => {
    const noteIndex = buildNoteIndex(
      'cellulaire cellulaire cellulaire',
      PRESENCE_PROFILES.balanced,
    );
    expect(rankCompletions({ course }, 'cell', 3)[0]?.term).toBe('cellule');
    expect(rankCompletions({ course, note: noteIndex }, 'cell', 3)[0]?.term).toBe(
      'cellulaire',
    );
  });

  it('offers a word only the note knows, unless the course silenced it', () => {
    const noteIndex = buildNoteIndex('celluloïd cytoplasme', PRESENCE_PROFILES.balanced);
    expect(rankCompletions({ course, note: noteIndex }, 'cyto', 3)[0]?.term).toBe(
      'cytoplasme',
    );
    expect(
      rankCompletions({ course, note: noteIndex }, 'cell', 5).map((entry) => entry.term),
    ).not.toContain('celluloïd');
  });

  it('ranks up what the student accepted before', () => {
    const learned = (key: string) => (key === 'cellulaire' ? 3 : 0);
    expect(rankCompletions({ course, learned }, 'cell', 3)[0]?.term).toBe('cellulaire');
  });

  it('harvests more eagerly the more present the student wants it', () => {
    const sources = [note('1', 'enzyme catalyse'), note('2', 'protéine')];
    const quiet = harvestVocabulary(sources, PRESENCE_PROFILES.quiet.course);
    const eager = harvestVocabulary(sources, PRESENCE_PROFILES.eager.course);
    expect(quiet).toHaveLength(0);
    expect(eager.map((term) => term.term)).toEqual(
      expect.arrayContaining(['enzyme', 'catalyse', 'protéine']),
    );
  });
});
