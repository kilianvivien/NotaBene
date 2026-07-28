import { describe, expect, it } from 'vitest';
import {
  createAbbreviation,
  endsWord,
  matchAbbreviation,
  normalizeAbbreviations,
} from './abbreviations';

function rules(...pairs: [string, string][]) {
  return pairs.map(([trigger, expansion]) => createAbbreviation(trigger, expansion));
}

describe('matchAbbreviation', () => {
  const list = rules(['thm', 'theorem'], ['def', 'definition'], ['def:', 'Definition —']);

  it('matches a trigger the user has just finished typing', () => {
    const match = matchAbbreviation('the fundamental thm', list);
    expect(match?.replacement).toBe('theorem');
    expect(match?.start).toBe(16);
  });

  it('leaves a trigger hiding inside a longer word alone', () => {
    expect(matchAbbreviation('logarithm', list)).toBeNull();
    expect(matchAbbreviation('undefined-def', list)).not.toBeNull();
  });

  it('prefers the longest matching trigger', () => {
    expect(matchAbbreviation('def:', list)?.replacement).toBe('Definition —');
  });

  it('carries the typed capitalisation onto the expansion', () => {
    expect(matchAbbreviation('Thm', list)?.replacement).toBe('Theorem');
    expect(matchAbbreviation('THM', list)?.replacement).toBe('THEOREM');
  });

  it('keeps a deliberately capitalised trigger case-sensitive', () => {
    const iso = rules(['SI', 'Système international']);
    expect(matchAbbreviation('SI', iso)?.replacement).toBe('Système international');
    expect(matchAbbreviation('si', iso)).toBeNull();
  });

  it('matches accented triggers as whole words', () => {
    const accented = rules(['éq', 'équation']);
    expect(matchAbbreviation('une éq', accented)?.replacement).toBe('équation');
    expect(matchAbbreviation('inéq', accented)).toBeNull();
  });

  it('allows a punctuation trigger straight after a word', () => {
    const punctuated = rules([';d', '→']);
    expect(matchAbbreviation('x;d', punctuated)?.replacement).toBe('→');
  });
});

describe('endsWord', () => {
  it('fires on word terminators only', () => {
    expect(endsWord(' ')).toBe(true);
    expect(endsWord('.')).toBe(true);
    expect(endsWord('a')).toBe(false);
    expect(endsWord('é')).toBe(false);
    expect(endsWord('4')).toBe(false);
    expect(endsWord('')).toBe(false);
  });

  it('reads the last character when several arrive at once', () => {
    expect(endsWord('thm ')).toBe(true);
    expect(endsWord('thm')).toBe(false);
  });
});

describe('normalizeAbbreviations', () => {
  it('drops anything that could not work, and keeps the first of a pair', () => {
    const normalized = normalizeAbbreviations([
      { id: 'a', trigger: '  thm  ', expansion: 'theorem' },
      { id: 'b', trigger: 'thm', expansion: 'thermodynamics' },
      { id: 'c', trigger: '', expansion: 'nothing' },
      { id: 'd', trigger: 'x', expansion: '' },
      { trigger: 'nb', expansion: 'nota bene' },
      'not an abbreviation',
      null,
    ]);

    expect(normalized.map((entry) => entry.trigger)).toEqual(['thm', 'nb']);
    expect(normalized[0]?.expansion).toBe('theorem');
    expect(normalized[1]?.id).toBeTruthy();
  });

  it('treats a missing or malformed list as empty', () => {
    expect(normalizeAbbreviations(undefined)).toEqual([]);
    expect(normalizeAbbreviations({ thm: 'theorem' })).toEqual([]);
  });
});
