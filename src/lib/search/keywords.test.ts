import { describe, expect, it } from 'vitest';
import { deriveKeywords, deriveTurnKeywords } from './keywords';

describe('deriveKeywords', () => {
  it('keeps the content words and drops the question scaffolding', () => {
    expect(deriveKeywords('What did she say about the second theorem?')).toEqual([
      'second',
      'theorem',
    ]);
  });

  it('drops French scaffolding too — the app has no per-question language', () => {
    expect(
      deriveKeywords("Pourquoi est-ce que le théorème de Fubini s'applique ?"),
    ).toEqual(['theoreme', 'fubini', 'applique']);
  });

  it('folds diacritics the way the FTS5 index does', () => {
    expect(deriveKeywords('théorème résumé')).toEqual(['theoreme', 'resume']);
  });

  it('keeps short tokens that carry a digit or shout', () => {
    // "vs" is short, lowercase and digitless — scaffolding, and dropped.
    expect(deriveKeywords('SN2 vs L2 and pH in TP')).toEqual(['sn2', 'l2', 'ph', 'tp']);
  });

  it('drops short filler that is neither', () => {
    expect(deriveKeywords('is it an ok idea')).toEqual(['idea']);
  });

  it('splits on punctuation the way the index does', () => {
    // `unicode61` would index these as separate tokens, so a term kept whole
    // here could never match anything.
    expect(deriveKeywords('half-life of carbon-14')).toEqual(['half', 'life', 'carbon', '14']);
  });

  it('deduplicates and caps', () => {
    expect(deriveKeywords('theorem theorem theorem')).toEqual(['theorem']);
    expect(deriveKeywords('alpha beta gamma delta epsilon', { max: 3 })).toHaveLength(3);
  });

  it('returns nothing for a question made only of stopwords', () => {
    expect(deriveKeywords('why is that so?')).toEqual([]);
    expect(deriveKeywords('et alors ?')).toEqual([]);
  });
});

describe('deriveTurnKeywords', () => {
  it('carries the previous question forward when this one says nothing', () => {
    expect(
      deriveTurnKeywords('why does that follow?', [
        'explain the spectral theorem',
      ]),
      // "follow" is a content word and survives; it is simply not enough on
      // its own to retrieve on.
    ).toEqual(['follow', 'spectral', 'theorem']);
  });

  it('prefers the most recent question when carrying forward', () => {
    const terms = deriveTurnKeywords('and why?', [
      'tell me about entropy',
      'what about enthalpy',
    ]);
    expect(terms.indexOf('enthalpy')).toBeLessThan(terms.indexOf('entropy'));
  });

  it('leaves a specific question alone', () => {
    expect(deriveTurnKeywords('define the spectral theorem', ['about entropy'])).toEqual([
      'define',
      'spectral',
      'theorem',
    ]);
  });

  it('still yields nothing when there is no history to lean on', () => {
    expect(deriveTurnKeywords('why?', [])).toEqual([]);
  });
});
