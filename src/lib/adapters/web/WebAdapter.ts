/**
 * Fetching a page the student asked for.
 *
 * A separate adapter rather than a method on the library: this is the one thing
 * NotaBene does that leaves the machine for a host nobody configured, and it
 * should be as easy to find, and as easy to refuse, as that deserves.
 *
 * Only ever called from a direct user action. There is no refresh loop, no
 * prefetch, and nothing here runs on a timer.
 */
export interface FetchedPage {
  /** Where the response came from after redirects; relative links resolve here. */
  finalUrl: string;
  contentType: string;
  html: string;
}

/** One row of a Wikipedia search, as `web.rs` hands it over. Parsed through
 * `WikipediaSearchSchema` before anything reads it. */
export interface WikipediaHitPayload {
  title: string;
  url: string;
  description?: string | null;
  excerpt?: string | null;
}

export interface WebAdapter {
  /** Rejects with a `code:message` string — `refused_host`, `not_html`,
   * `too_large`, `http_error`, and so on — which the UI translates. */
  fetchPage(url: string): Promise<FetchedPage>;

  /**
   * Ask one Wikipedia language edition what it has on a phrase.
   *
   * Separate from `fetchPage` because it is a narrower door: the host is built
   * in Rust from the language code, so this cannot be pointed anywhere else,
   * and the article itself is still fetched through `fetchPage` afterwards
   * like any other link.
   */
  searchWikipedia(language: string, query: string): Promise<WikipediaHitPayload[]>;
}
