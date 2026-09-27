import { describe, expect, it } from 'vitest';
import { frontmatterList, parseFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  it('reads scalars, flow sequences and block sequences, and strips the block', () => {
    const parsed = parseFrontmatter(
      [
        '---',
        'title: "Oscillateurs — été"',
        "author: 'O''Neil'",
        'tags: [physics, "waves, damped"]',
        'aliases:',
        '  - Damping',
        '  - Amortissement',
        'created: 2026-09-01 # first lecture',
        '---',
        '',
        '# Body',
      ].join('\n'),
    );
    expect(parsed.data).toEqual({
      title: 'Oscillateurs — été',
      author: "O'Neil",
      tags: ['physics', 'waves, damped'],
      aliases: ['Damping', 'Amortissement'],
      created: '2026-09-01',
    });
    expect(parsed.body).toBe('# Body');
    expect(parsed.unsupported).toEqual([]);
  });

  it('refuses what it does not read rather than guessing, and says which keys', () => {
    const parsed = parseFrontmatter(
      ['---', 'meta:', '  nested: map', 'summary: |', 'kept: yes', '---', 'text'].join(
        '\n',
      ),
    );
    expect(parsed.data).toEqual({ kept: 'yes' });
    expect(parsed.unsupported.sort()).toEqual(['meta', 'summary']);
  });

  it('round-trips what NotaBene’s own Markdown export writes', () => {
    const parsed = parseFrontmatter(
      [
        '---',
        'title: "Week 4"',
        'course: "Physics"',
        'tags: ["topic:Waves", "exam"]',
        'created: "2026-09-01T08:00:00.000Z"',
        'updated: "2026-09-02T08:00:00.000Z"',
        '---',
        '',
      ].join('\n'),
    );
    expect(parsed.data.tags).toEqual(['topic:Waves', 'exam']);
    expect(parsed.data.created).toBe('2026-09-01T08:00:00.000Z');
  });

  it('leaves a note without a closed block untouched', () => {
    const text = '---\nnot: closed\n\nJust a rule above.';
    expect(parseFrontmatter(text)).toEqual({ data: {}, body: text, unsupported: [] });
  });

  it('treats a single value as a one-item list', () => {
    expect(frontmatterList('physics waves')).toEqual(['physics', 'waves']);
    expect(frontmatterList('Ada Lovelace; Alan Turing', /\s*;\s*/)).toEqual([
      'Ada Lovelace',
      'Alan Turing',
    ]);
  });
});
