import { describe, expect, it, vi } from 'vitest';
import { requestLinkSuggestions, MAX_LINK_SUGGESTIONS } from './linkSuggestions';
import type { ResolvedProvider } from './protocols';
import * as structured from './structured';

const NOTES = ['Damping', 'Resonance', 'Week 4', 'Lab 3'].map((title, index) => ({
  id: `n${index}`,
  title,
  course: null,
  excerpt: `${title} begins here.`,
}));

function answering(links: { from: number; to: number; reason: string }[]) {
  return vi.spyOn(structured, 'runStructured').mockResolvedValue({ links });
}

async function suggest(linked: string[] = []) {
  return requestLinkSuggestions({
    provider: {} as ResolvedProvider,
    notes: NOTES,
    linked: new Set(linked),
    language: 'en',
  });
}

describe('requestLinkSuggestions', () => {
  it('turns positions back into notes', async () => {
    answering([{ from: 2, to: 0, reason: 'The lecture introduces it.' }]);
    expect(await suggest()).toEqual([
      { sourceId: 'n2', targetId: 'n0', reason: 'The lecture introduces it.' },
    ]);
  });

  it('drops what no note stands behind: a position off the list, a self-link', async () => {
    answering([
      { from: 9, to: 0, reason: 'invented' },
      { from: 1, to: 1, reason: 'itself' },
      { from: 1, to: 0, reason: 'real' },
    ]);
    expect((await suggest()).map((link) => link.reason)).toEqual(['real']);
  });

  it('keeps one suggestion per pair, whichever way round', async () => {
    answering([
      { from: 1, to: 0, reason: 'first' },
      { from: 0, to: 1, reason: 'again, reversed' },
    ]);
    expect(await suggest()).toHaveLength(1);
  });

  it('never suggests a pair the student already linked, in either direction', async () => {
    answering([
      { from: 1, to: 0, reason: 'already there' },
      { from: 3, to: 2, reason: 'new' },
    ]);
    expect((await suggest(['n0>n1'])).map((link) => link.reason)).toEqual(['new']);
  });

  it('stops at the number a student will read', async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      from: index % 4,
      to: (index + 1 + Math.floor(index / 4)) % 4,
      reason: `r${index}`,
    }));
    answering(many);
    expect((await suggest()).length).toBeLessThanOrEqual(MAX_LINK_SUGGESTIONS);
  });
});
