/**
 * A web page, reduced to the article it is mostly hiding.
 *
 * This runs in the webview rather than in Rust, and that is safe for a reason
 * worth stating: `DOMParser` builds a tree without executing anything —
 * scripts do not run, `<img>` does not fetch, inline handlers never fire. The
 * bytes arrive from `web.rs` precisely so the webview never opens a connection
 * of its own.
 *
 * The output is Markdown, not HTML, and that is the decision the whole feature
 * rests on. Markdown is already a previewable attachment kind, already what the
 * document importer turns into a note, and — because the app renders it through
 * `markdownToDoc` into React components rather than `innerHTML` — a hostile page
 * has nothing to inject. Storing HTML would have meant owning a sanitiser.
 */
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export interface ExtractedPage {
  title: string;
  markdown: string;
  /** Author line, when the page declared one. */
  byline: string | null;
  /** The site's own name, for the attachment label. */
  siteName: string | null;
  /** True when Readability found nothing and the whole body was used. */
  fellBack: boolean;
}

/**
 * Turndown, configured once.
 *
 * Images are dropped in this version. An article's images live on the site's
 * servers, so keeping them would mean either fetching each one into an asset —
 * real work, and slow — or leaving `<img src="https://…">` in a note, which
 * would phone that server every time the note was opened. Dropping them is the
 * honest option until the first is built.
 */
function turndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });

  service.addRule('dropImages', {
    filter: ['img', 'picture', 'figure'],
    replacement: () => '',
  });

  // Neither survives a round trip through the note model, and both arrive as
  // page furniture rather than article content.
  service.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button']);

  return service;
}

/** Rewrite every relative `href` against the page it came from. */
function absolutise(root: Element, base: string): void {
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    try {
      anchor.setAttribute('href', new URL(href, base).toString());
    } catch {
      // A link the URL parser will not take is a link worth leaving alone.
    }
  }
}

/** Collapse the runs of blank lines that page markup tends to leave behind. */
function tidy(markdown: string): string {
  return markdown
    // Non-breaking spaces, written as an escape: page markup is full of them,
    // and a literal one here is invisible to the next reader.
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last).replace(/[-_]+/g, ' ') : parsed.hostname;
  } catch {
    return 'Web page';
  }
}

/**
 * Pull the readable article out of a page's HTML.
 *
 * Never throws for an unreadable page: a site Readability cannot make sense of
 * falls back to the whole body, which is worse but is still the page. Only
 * genuinely unparseable input is an error, and it says so.
 */
export function extractPage(html: string, url: string): ExtractedPage {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, 'text/html');

  // A `<base>` is what makes Readability's own relative-URL handling correct;
  // without it every link in the article resolves against the app's origin.
  const base = document.createElement('base');
  base.setAttribute('href', url);
  document.head?.prepend(base);

  const documentTitle = document.title?.trim() ?? '';

  // Readability consumes the document it is given, so it gets a clone and the
  // fallback keeps a readable original.
  const article = new Readability(document.cloneNode(true) as Document).parse();

  const service = turndown();
  let markdown = '';
  let fellBack = false;

  if (article?.content) {
    const holder = document.createElement('div');
    holder.innerHTML = article.content;
    absolutise(holder, url);
    markdown = service.turndown(holder.innerHTML);
  }

  if (!tidy(markdown)) {
    fellBack = true;
    const body = document.body;
    if (body) {
      absolutise(body, url);
      markdown = service.turndown(body.innerHTML);
    }
  }

  const cleaned = tidy(markdown);
  if (!cleaned) {
    throw new Error('empty_page:that page had no readable text');
  }

  const title = (article?.title || documentTitle || fallbackTitle(url)).trim();

  return {
    title: title || fallbackTitle(url),
    markdown: cleaned,
    byline: article?.byline?.trim() || null,
    siteName: article?.siteName?.trim() || null,
    fellBack,
  };
}

/**
 * The snapshot as it is stored: the article, under a heading, with a line
 * saying where it came from and when.
 *
 * The provenance line is not decoration. A reader view is a copy of someone
 * else's work sitting in a private library; the source has to travel with it,
 * and it has to survive being turned into a note, which means it belongs in the
 * Markdown rather than in chrome around it.
 */
export function snapshotMarkdown(page: ExtractedPage, url: string, fetchedAt: string): string {
  const stamp = new Date(fetchedAt);
  const when = Number.isNaN(stamp.getTime()) ? fetchedAt : stamp.toISOString().slice(0, 10);
  const credit = [page.byline, page.siteName].filter(Boolean).join(' · ');

  return [
    `# ${page.title}`,
    '',
    credit ? `${credit}` : null,
    `[${url}](${url}) — saved ${when}`,
    '',
    '---',
    '',
    page.markdown,
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** A filename for the snapshot asset. `.md` is what makes preview and
 * note-conversion work with no new code on either path. */
export function snapshotFilename(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${safe || 'Web page'}.md`;
}
