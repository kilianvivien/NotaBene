import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDocumentMatches, paintDocumentMatches } from './useDocumentSearch';

class MockHighlight extends Set<AbstractRange> {
  constructor(...ranges: AbstractRange[]) {
    super(ranges);
  }
}

describe('document search highlights', () => {
  let highlights: Map<string, MockHighlight>;

  beforeEach(() => {
    highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', MockHighlight);
  });

  afterEach(() => {
    clearDocumentMatches();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.nbFind;
  });

  it('clears matches by mutating stable highlights for WebKit', () => {
    const container = document.createElement('div');
    container.textContent = 'public transport, public service';

    expect(paintDocumentMatches(container, 'public', 0)).toBe(2);
    const all = highlights.get('nb-find');
    const current = highlights.get('nb-find-current');
    expect(all?.size).toBe(2);
    expect(current?.size).toBe(1);
    expect(document.documentElement.dataset.nbFind).toBe('');

    clearDocumentMatches();

    expect(highlights.get('nb-find')).toBe(all);
    expect(highlights.get('nb-find-current')).toBe(current);
    expect(all?.size).toBe(0);
    expect(current?.size).toBe(0);
    expect(document.documentElement.dataset.nbFind).toBeUndefined();
  });

  it('reuses the cleared highlights for the next query', () => {
    const container = document.createElement('div');
    container.textContent = 'alpha beta';

    paintDocumentMatches(container, 'alpha');
    const all = highlights.get('nb-find');
    clearDocumentMatches();
    paintDocumentMatches(container, 'beta');

    expect(highlights.get('nb-find')).toBe(all);
    expect(all?.size).toBe(1);
  });
});
