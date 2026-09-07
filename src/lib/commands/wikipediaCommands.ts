/**
 * Wikipedia, as a way into a note.
 *
 * Two things a student does with an article and one search behind both: drop a
 * link into the prose they are writing, or keep the article itself so it is
 * still there on the train home. Saving reuses `attachWebLinkCommand` outright
 * — a Wikipedia article is a web page, and giving it a second storage path
 * would mean a second thing to keep working.
 *
 * Nothing here runs on its own. Wikipedia is contacted when the student types
 * in the search field and at no other time; there is no prefetch and no
 * suggestion loop behind the scenes.
 */
import { z } from 'zod';
import { web } from '@/lib/adapters';
import {
  WikipediaArticleUrlSchema,
  WikipediaSearchSchema,
  type Attachment,
  type WikipediaHit,
} from '@/lib/schema';
import { attachWebLinkCommand } from './webLinkCommands';
import { fail, ok, USER, type CommandContext, type CommandResult } from './types';

const SearchInput = z.object({
  /** A Wikipedia language edition — `fr`, `en`, `zh-yue`. Rust validates it
   * again before it becomes a hostname. */
  language: z.string().min(1).max(12),
  query: z.string(),
});
export type SearchWikipediaInput = z.input<typeof SearchInput>;

const AttachInput = z.object({
  noteId: z.string().min(1),
  // The article's own schema, not `z.string().url()`: this address came from a
  // search result rather than from a person, and the check that matters is that
  // it is still a Wikipedia article.
  url: WikipediaArticleUrlSchema,
});
export type AttachWikipediaInput = z.input<typeof AttachInput>;

/**
 * The editions offered in the picker.
 *
 * Not the full list of three hundred. The app ships in two languages and a
 * student reads sources in a third or fourth, so this is the shortlist a
 * European undergraduate actually reaches for, in each edition's own name —
 * "Deutsch", not "German", because that is what the site calls itself.
 */
export const WIKIPEDIA_LANGUAGES = [
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'la', label: 'Latina' },
] as const;

/** Turn a `code:message` rejection from the fetch layer into a command result. */
function searchFailure<T>(error: unknown): CommandResult<T> {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.split(':', 1)[0] ?? '';
  const invalid = ['invalid_language', 'invalid_url', 'unsupported'];
  return fail(invalid.includes(code) ? 'invalid_input' : 'storage_failed', raw);
}

export async function searchWikipediaCommand(
  input: SearchWikipediaInput,
  _context: CommandContext = USER,
): Promise<CommandResult<WikipediaHit[]>> {
  const parsed = SearchInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid search', parsed.error.issues);
  }
  // An empty box is not a failed search, and asking Wikipedia about "" would be
  // a request nobody made.
  if (!parsed.data.query.trim()) return ok([]);

  let payload;
  try {
    payload = await web.searchWikipedia(parsed.data.language, parsed.data.query.trim());
  } catch (error) {
    return searchFailure(error);
  }

  const hits = WikipediaSearchSchema.safeParse(payload);
  if (!hits.success) {
    return fail('invalid_input', 'bad_response:that search came back malformed');
  }
  return ok(hits.data);
}

/**
 * Keep the article, not just the address.
 *
 * Straight through the web-link command, so the result is an ordinary `.md`
 * attachment: it previews, it re-fetches, it converts to a note, and it reads
 * on a train. The only thing this adds is the check that the address is still a
 * Wikipedia article, because the caller got it from a response body rather than
 * from a person.
 */
export async function attachWikipediaArticleCommand(
  input: AttachWikipediaInput,
  context: CommandContext = USER,
): Promise<CommandResult<Attachment>> {
  const parsed = AttachInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid article', parsed.error.issues);
  }
  return attachWebLinkCommand(parsed.data, context);
}
