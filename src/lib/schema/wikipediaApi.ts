/**
 * What a Wikipedia edition says it has on a phrase.
 *
 * A search result is a payload from outside, so it is parsed rather than
 * trusted — same rule as a model listing or an LLM's JSON. Narrow on purpose:
 * only the fields the dialog draws appear, so a new key in a future MediaWiki
 * release cannot fail a search.
 *
 * The URL is built in `web.rs` from a validated host, and checked again here.
 * `z.string().url()` is not that check: it accepts `javascript:alert(1)` and
 * `data:text/html,…` quite happily, because those *are* URLs. One of the two
 * things this dialog does with an address is put it in a note as an `href`,
 * which never reaches Rust's scheme guard — so the assertion has to be made
 * where it is claimed.
 */
import { z } from 'zod';

/** `https:` and a Wikipedia host — the only address a search can produce. */
export function isWikipediaArticle(value: string): boolean {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    (url.hostname === 'wikipedia.org' || url.hostname.endsWith('.wikipedia.org'))
  );
}

export const WikipediaHitSchema = z.object({
  title: z.string().min(1),
  url: z.string().refine(isWikipediaArticle, 'not a Wikipedia article address'),
  /** Wikidata's one-line gloss, when the article has one. */
  description: z.string().nullish(),
  /** The matching sentence, as HTML with the hit wrapped in a `<span>`. */
  excerpt: z.string().nullish(),
});

export const WikipediaSearchSchema = z.array(WikipediaHitSchema);

/** The same assertion, for an address handed back to a command rather than
 * arriving in a response body. */
export const WikipediaArticleUrlSchema = z
  .string()
  .refine(isWikipediaArticle, 'not a Wikipedia article address');

export type WikipediaHit = z.infer<typeof WikipediaHitSchema>;
