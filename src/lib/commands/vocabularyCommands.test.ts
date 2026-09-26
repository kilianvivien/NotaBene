import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { locateCorrections } from '@/lib/ai/proofread';
import { safeImportLibrary } from '@/lib/schema';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { ensureCompletionIndex, resetVocabularyCache } from '@/lib/vocabulary/cache';
import { createCourseCommand, deleteCourseCommand } from './organizationCommands';
import {
  applyVocabularyReviewCommand,
  filterVocabularyProposal,
  proofreadCommand,
  proposeVocabularyCommand,
  removeCourseTermCommand,
  setCourseTermCommand,
} from './vocabularyCommands';

beforeEach(() => {
  memoryLibraryAdapter.reset();
  resetVocabularyCache();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
});

async function course(name = 'Biologie cellulaire'): Promise<string> {
  const created = await createCourseCommand({ name });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

describe('course terms', () => {
  it('keeps one row per word, whatever its accents or case', async () => {
    const courseId = await course();
    await setCourseTermCommand({ courseId, term: 'Schrodinger' });
    const fixed = await setCourseTermCommand({ courseId, term: 'Schrödinger' });
    expect(fixed.ok).toBe(true);

    const terms = await library.listCourseTerms(courseId);
    expect(terms.map((entry) => entry.term)).toEqual(['Schrödinger']);
  });

  it('turns an accepted word into a silenced one in place', async () => {
    const courseId = await course();
    await setCourseTermCommand({ courseId, term: 'ribosomme' });
    await setCourseTermCommand({ courseId, term: 'ribosomme', status: 'rejected' });
    const terms = await library.listCourseTerms(courseId);
    expect(terms).toHaveLength(1);
    expect(terms[0]?.status).toBe('rejected');
  });

  it('refuses a pasted sentence, a number, and an unknown course', async () => {
    const courseId = await course();
    const sentence = await setCourseTermCommand({ courseId, term: 'x'.repeat(80) });
    const number = await setCourseTermCommand({ courseId, term: '2026' });
    const nowhere = await setCourseTermCommand({ courseId: 'missing', term: 'cellule' });
    expect(sentence.ok ? '' : sentence.code).toBe('invalid_input');
    expect(number.ok ? '' : number.code).toBe('invalid_input');
    expect(nowhere.ok ? '' : nowhere.code).toBe('not_found');
  });

  it('records who put a word on the list', async () => {
    const courseId = await course();
    await setCourseTermCommand({ courseId, term: 'cytosquelette' });
    await setCourseTermCommand({ courseId, term: 'cytoplasme' }, { source: 'ai' });
    const sources = Object.fromEntries(
      (await library.listCourseTerms(courseId)).map((entry) => [
        entry.term,
        entry.source,
      ]),
    );
    expect(sources).toEqual({ cytosquelette: 'user', cytoplasme: 'ai' });
  });

  it('removes a word, and loses a course’s words with the course', async () => {
    const courseId = await course();
    const kept = await setCourseTermCommand({ courseId, term: 'cellule' });
    await setCourseTermCommand({ courseId, term: 'noyau' });
    if (!kept.ok) throw new Error('expected a term');

    await removeCourseTermCommand(kept.value.id);
    expect((await library.listCourseTerms(courseId)).map((entry) => entry.term)).toEqual([
      'noyau',
    ]);

    await deleteCourseCommand(courseId);
    expect(await library.listCourseTerms(null)).toEqual([]);
  });

  it('reaches the completer once the course’s index is rebuilt', async () => {
    const courseId = await course();
    await ensureCompletionIndex(courseId);
    await setCourseTermCommand({ courseId, term: 'mitochondrie' });
    const index = await ensureCompletionIndex(courseId);
    expect(index.complete('mito')?.term).toBe('mitochondrie');

    await setCourseTermCommand({ courseId, term: 'mitochondrie', status: 'rejected' });
    expect((await ensureCompletionIndex(courseId)).complete('mito')).toBeNull();
  });

  it('survives a backup round trip', async () => {
    const courseId = await course();
    await setCourseTermCommand({ courseId, term: 'mitochondrie' });
    const exported = await library.exportLibrary();
    const restored = safeImportLibrary(JSON.parse(JSON.stringify(exported)));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    memoryLibraryAdapter.reset();
    await library.importLibrary(restored.library, 'replace');
    expect((await library.listCourseTerms(courseId)).map((entry) => entry.term)).toEqual([
      'mitochondrie',
    ]);
  });
});

describe('vocabulary review', () => {
  it('drops proposals nobody could usefully accept', () => {
    const proposal = filterVocabularyProposal(
      {
        corrections: [
          { from: 'cellule', to: 'cellule' },
          { from: 'theoreme', to: 'théorème' },
          { from: 'theoreme', to: 'théorème' },
        ],
        terms: [{ term: 'cytoplasme' }, { term: 'Cytoplasme' }, { term: 'noyau' }],
        acronyms: [
          { acronym: 'ATP', expansion: 'adénosine triphosphate' },
          { acronym: 'ADN', expansion: 'acide désoxyribonucléique' },
          { acronym: 'A B', expansion: 'not a trigger' },
        ],
      },
      [
        {
          id: 't',
          courseId: 'c',
          term: 'noyau',
          status: 'accepted',
          source: 'user',
          createdAt: new Date().toISOString(),
        },
      ],
      [{ id: 'a', trigger: 'atp', expansion: 'already here' }],
    );
    expect(proposal.corrections).toEqual([{ from: 'theoreme', to: 'théorème' }]);
    expect(proposal.terms).toEqual(['cytoplasme']);
    expect(proposal.acronyms.map((entry) => entry.acronym)).toEqual(['ADN']);
  });

  it('writes only what was ticked, silencing a real typo but not a missing accent', async () => {
    const courseId = await course();
    const result = await applyVocabularyReviewCommand(courseId, {
      corrections: [
        { from: 'theoreme', to: 'théorème' },
        { from: 'ribosomme', to: 'ribosome' },
      ],
      terms: ['cytoplasme'],
      acronyms: [{ acronym: 'ADN', expansion: 'acide désoxyribonucléique' }],
    });
    expect(result.ok).toBe(true);

    const terms = await library.listCourseTerms(courseId);
    const byTerm = Object.fromEntries(terms.map((entry) => [entry.term, entry.status]));
    expect(byTerm).toEqual({
      théorème: 'accepted',
      ribosomme: 'rejected',
      ribosome: 'accepted',
      cytoplasme: 'accepted',
    });
    expect(terms.every((entry) => entry.source === 'ai')).toBe(true);
    expect(useSettingsStore.getState().settings.abbreviations).toMatchObject([
      { trigger: 'ADN', expansion: 'acide désoxyribonucléique' },
    ]);
  });

  it('asks nothing of a provider for a course that does not exist, and says when none is set up', async () => {
    const missing = await proposeVocabularyCommand({ courseId: 'missing' });
    expect(missing.ok ? '' : missing.code).toBe('not_found');

    const courseId = await course();
    const unconfigured = await proposeVocabularyCommand({ courseId });
    expect(unconfigured.ok ? '' : unconfigured.code).toBe('not_supported');
  });
});

describe('proofread', () => {
  it('refuses an overlong paragraph before it costs a request', async () => {
    const result = await proofreadCommand({ paragraph: 'mot '.repeat(2_000) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_input');
    expect(result.details).toMatchObject({ reason: 'too_long' });
  });

  it('says when no provider is set up', async () => {
    const result = await proofreadCommand({ paragraph: 'Il y a trois fautes.' });
    expect(result.ok ? '' : result.code).toBe('not_supported');
  });

  it('keeps only corrections it can point at, in order, without overlaps', () => {
    const located = locateCorrections('la cellule et la cellule du noyeau', [
      { original: 'noyeau', replacement: 'noyau' },
      { original: 'cellule', replacement: 'cellules' },
      { original: 'cellule', replacement: 'cellules' },
      { original: 'invented span', replacement: 'x' },
      { original: 'la cellule', replacement: 'les cellules' },
      { original: 'et', replacement: 'et' },
    ]);
    expect(located.map((entry) => [entry.original, entry.index])).toEqual([
      ['cellule', 3],
      ['cellule', 17],
      ['noyeau', 28],
    ]);
  });
});
