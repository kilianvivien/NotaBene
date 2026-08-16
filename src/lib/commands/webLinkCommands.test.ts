import { beforeEach, describe, expect, it, vi } from 'vitest';
import { library, web } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { attachWebLinkCommand, normaliseUrl, refetchWebLinkCommand } from './webLinkCommands';

const PAGE = `<!doctype html>
<html>
  <head><title>The second law | Physics Weekly</title></head>
  <body>
    <nav><a href="/">Home</a></nav>
    <article>
      <h1>The second law</h1>
      <p>Entropy of an isolated system never decreases, and this paragraph is
      long enough that the extractor treats it as the body of the article rather
      than as another piece of navigation furniture.</p>
      <p>A second paragraph, also long enough to be scored as real content by a
      heuristic that is looking for prose rather than for chrome.</p>
    </article>
  </body>
</html>`;

function stubFetch(html = PAGE, finalUrl = 'https://example.com/second-law') {
  return vi
    .spyOn(web, 'fetchPage')
    .mockResolvedValue({ finalUrl, contentType: 'text/html', html });
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  vi.restoreAllMocks();
});

describe('normaliseUrl', () => {
  it('assumes https for what people actually type', () => {
    expect(normaliseUrl('example.com/article')).toBe('https://example.com/article');
  });

  it('leaves a URL that already names its scheme alone', () => {
    expect(normaliseUrl('http://example.com')).toBe('http://example.com');
  });
});

describe('attachWebLinkCommand', () => {
  it('stores the article as a Markdown attachment carrying its source', async () => {
    stubFetch();
    const note = memoryLibraryAdapter.seedNote({ title: 'Thermo' });

    const result = await attachWebLinkCommand({
      noteId: note.id,
      url: 'example.com/second-law',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe('https://example.com/second-law');
    expect(result.value.fetchedAt).not.toBeNull();
    // `.md` is what makes the existing preview and import paths work unchanged.
    expect(result.value.name.endsWith('.md')).toBe(true);
    expect(await library.listAttachments(note.id)).toHaveLength(1);
  });

  it('records the address that answered, not the one that was typed', async () => {
    stubFetch(PAGE, 'https://www.example.com/second-law?amp=0');
    const note = memoryLibraryAdapter.seedNote({ title: 'Thermo' });

    const result = await attachWebLinkCommand({
      noteId: note.id,
      url: 'http://example.com/second-law',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.url).toBe('https://www.example.com/second-law?amp=0');
  });

  it('reads a refused host as the student’s mistake, not a broken app', async () => {
    vi.spyOn(web, 'fetchPage').mockRejectedValue(
      new Error('refused_host:that address is not on the public web'),
    );
    const note = memoryLibraryAdapter.seedNote({ title: 'Thermo' });

    const result = await attachWebLinkCommand({
      noteId: note.id,
      url: 'http://127.0.0.1:22600/mcp',
    });

    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await library.listAttachments(note.id)).toHaveLength(0);
  });

  it('refuses a page with no readable text rather than saving an empty file', async () => {
    stubFetch('<html><body></body></html>');
    const note = memoryLibraryAdapter.seedNote({ title: 'Thermo' });

    const result = await attachWebLinkCommand({ noteId: note.id, url: 'example.com' });

    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('refetchWebLinkCommand', () => {
  it('replaces the snapshot in place rather than adding a second one', async () => {
    stubFetch();
    const note = memoryLibraryAdapter.seedNote({ title: 'Thermo' });
    const first = await attachWebLinkCommand({ noteId: note.id, url: 'example.com/x' });
    if (!first.ok) throw new Error('fixture failed');

    stubFetch(PAGE.replace('never decreases', 'never decreases, as revised'));
    const again = await refetchWebLinkCommand(first.value);

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.id).toBe(first.value.id);
    expect(again.value.assetId).not.toBe(first.value.assetId);
    expect(await library.listAttachments(note.id)).toHaveLength(1);
  });

  it('refuses an ordinary file, which has no page to fetch again', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Thermo' });
    const result = await refetchWebLinkCommand({
      id: 'a-1',
      noteId: note.id,
      assetId: 'asset-1',
      name: 'paper.pdf',
      createdAt: new Date().toISOString(),
      annotations: [],
      url: null,
      fetchedAt: null,
    });

    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});
