import { beforeEach, describe, expect, it, vi } from 'vitest';
import { library, web } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import {
  attachWikipediaArticleCommand,
  searchWikipediaCommand,
} from './wikipediaCommands';

const HIT = {
  title: 'Haute Autorité pour la transparence de la vie publique',
  url: 'https://fr.wikipedia.org/wiki/Haute_Autorité_pour_la_transparence_de_la_vie_publique',
  description: 'Autorité administrative indépendante française',
  excerpt: 'La <span class="searchmatch">HATVP</span> est une autorité',
};

const ARTICLE = `<!doctype html>
<html>
  <head><title>Haute Autorité — Wikipédia</title></head>
  <body>
    <article>
      <h1>Haute Autorité pour la transparence de la vie publique</h1>
      <p>La Haute Autorité pour la transparence de la vie publique est une
      autorité administrative indépendante française, et ce paragraphe est assez
      long pour que l'extracteur le prenne pour le corps de l'article plutôt que
      pour un élément de navigation.</p>
      <p>Un deuxième paragraphe, lui aussi assez long pour être compté comme du
      texte véritable par une heuristique qui cherche de la prose.</p>
    </article>
  </body>
</html>`;

beforeEach(() => {
  memoryLibraryAdapter.reset();
  vi.restoreAllMocks();
});

describe('searchWikipediaCommand', () => {
  it('asks the edition the caller named', async () => {
    const search = vi.spyOn(web, 'searchWikipedia').mockResolvedValue([HIT]);
    const result = await searchWikipediaCommand({ language: 'fr', query: ' hatvp ' });
    expect(search).toHaveBeenCalledWith('fr', 'hatvp');
    expect(result.ok && result.value[0]?.title).toBe(HIT.title);
  });

  /** An empty box is not a failed search, and Wikipedia should not hear about
   * a query nobody typed. */
  it('does not go to the network for an empty query', async () => {
    const search = vi.spyOn(web, 'searchWikipedia').mockResolvedValue([HIT]);
    const result = await searchWikipediaCommand({ language: 'fr', query: '   ' });
    expect(search).not.toHaveBeenCalled();
    expect(result.ok && result.value).toEqual([]);
  });

  it('refuses a response that is not the shape it claims', async () => {
    vi.spyOn(web, 'searchWikipedia').mockResolvedValue([
      { title: 'x', url: 'not-a-url' },
    ] as never);
    const result = await searchWikipediaCommand({ language: 'fr', query: 'x' });
    expect(result.ok).toBe(false);
  });

  it('reads the desktop-only refusal as the student’s situation, not a fault', async () => {
    vi.spyOn(web, 'searchWikipedia').mockRejectedValue(
      new Error('unsupported:searching Wikipedia needs the desktop app'),
    );
    const result = await searchWikipediaCommand({ language: 'fr', query: 'x' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('invalid_input');
  });
});

describe('attachWikipediaArticleCommand', () => {
  it('files the article as an ordinary web-link attachment', async () => {
    vi.spyOn(web, 'fetchPage').mockResolvedValue({
      finalUrl: HIT.url,
      contentType: 'text/html',
      html: ARTICLE,
    });

    const note = { id: 'note-1' };
    const result = await attachWikipediaArticleCommand({
      noteId: note.id,
      url: HIT.url,
    });

    expect(result.ok).toBe(true);
    const stored = await library.listAttachments(note.id);
    expect(stored).toHaveLength(1);
    // A `.md` attachment is what already previews, re-fetches and converts to a
    // note; a Wikipedia-shaped one would have needed all three again.
    expect(stored[0]?.name.endsWith('.md')).toBe(true);
    expect(stored[0]?.url).toBe(HIT.url);
  });

  /** These are all valid URLs as far as `z.string().url()` is concerned, so
   * the refusal has to come from the article schema rather than from the fetch
   * failing later for some unrelated reason. */
  it('refuses an address that is not a Wikipedia article', async () => {
    const fetchPage = vi.spyOn(web, 'fetchPage');
    for (const url of [
      'javascript:alert(1)',
      'https://evil.com/wiki/X',
      'http://fr.wikipedia.org/wiki/X',
    ]) {
      const result = await attachWikipediaArticleCommand({ noteId: 'note-1', url });
      expect(result.ok, url).toBe(false);
    }
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
