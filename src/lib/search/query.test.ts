import { describe, expect, it } from 'vitest';
import { parseQuery, resolveQuery } from './query';

describe('parseQuery', () => {
  it('keeps bare words as free text', () => {
    expect(parseQuery('chain rule proof').text).toBe('chain rule proof');
  });

  it('extracts filters and leaves the rest as text', () => {
    const parsed = parseQuery('course:Analysis integral has:image');
    expect(parsed.text).toBe('integral');
    expect(parsed.has).toEqual(['image']);
    expect(parsed.unresolved).toEqual([{ key: 'course', value: 'Analysis' }]);
  });

  it('keeps a quoted value together', () => {
    const parsed = parseQuery('course:"Linear Algebra" basis');
    expect(parsed.unresolved).toEqual([{ key: 'course', value: 'Linear Algebra' }]);
    expect(parsed.text).toBe('basis');
  });

  it('treats an unknown key as free text rather than erroring', () => {
    // A pasted URL must not become a syntax error.
    expect(parseQuery('https://example.com/notes').text).toBe('https://example.com/notes');
  });

  it('turns on: into a whole-day range', () => {
    const parsed = parseQuery('on:2026-03-14');
    expect(parsed.createdAfter).toBe('2026-03-14T00:00:00.000Z');
    expect(parsed.createdBefore).toBe('2026-03-14T23:59:59.999Z');
  });

  it('falls back to text for a malformed date', () => {
    const parsed = parseQuery('before:yesterday');
    expect(parsed.createdBefore).toBeUndefined();
    expect(parsed.text).toBe('before:yesterday');
  });

  it('reads is:pinned and is:archived as scope', () => {
    expect(parseQuery('is:pinned').pinned).toBe(true);
    expect(parseQuery('is:archived').scope).toBe('archived');
  });
});

describe('resolveQuery', () => {
  const lookup = {
    courseIdByName: (name: string) => (name === 'Analysis' ? 'course-1' : undefined),
    tagIdByName: (namespace: string | null, name: string) =>
      namespace === 'topic' && name === 'limits' ? 'tag-1' : undefined,
  };

  it('folds names into ids', () => {
    const resolved = resolveQuery(parseQuery('course:Analysis topic:limits'), lookup);
    expect(resolved.courseId).toBe('course-1');
    expect(resolved.tagIds).toEqual(['tag-1']);
    expect(resolved.unresolvable).toBe(false);
  });

  it('flags a filter that matches nothing, so the caller can return no results', () => {
    // Silently dropping it would widen the search instead of narrowing it —
    // a typo'd course name must not return the whole library.
    const resolved = resolveQuery(parseQuery('course:Typo'), lookup);
    expect(resolved.unresolvable).toBe(true);
    expect(resolved.courseId).toBeUndefined();
  });
});
