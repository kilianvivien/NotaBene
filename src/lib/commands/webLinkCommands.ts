/**
 * Saving a web page as an attachment.
 *
 * Three steps, none of them clever: fetch the bytes through Rust, reduce them
 * to the article as Markdown, and store that as an ordinary attachment whose
 * name ends in `.md`. The last part is the trick — a `.md` attachment already
 * previews (`AttachmentDocumentPreview`) and already converts to a note (the
 * document importer treats Markdown as passthrough), so neither of those paths
 * needed a line of new code.
 *
 * Nothing here runs on its own. A page is fetched when the student asks for it
 * and at no other time.
 */
import { z } from 'zod';
import { assets, library, web } from '@/lib/adapters';
import { extractPage, snapshotFilename, snapshotMarkdown } from '@/lib/import/webPage';
import { AttachmentSchema, newId, type Attachment } from '@/lib/schema';
import { attachmentsChanged } from '@/lib/state/attachmentStore';
import {
  fail,
  ok,
  USER,
  type CommandContext,
  type CommandResult,
} from './types';

const LinkInput = z.object({
  noteId: z.string().min(1),
  url: z.string().url(),
});
export type AttachWebLinkInput = z.input<typeof LinkInput>;

/**
 * Normalise what someone pasted.
 *
 * A bare `example.com/article` is what people type; assuming `https` is both
 * what they meant and the safer of the two guesses.
 */
export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Turn a `code:message` rejection from the fetch layer into a command result. */
function fetchFailure<T>(error: unknown): CommandResult<T> {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.split(':', 1)[0] ?? '';
  // The guard refusals are the student's mistake to correct, not a storage
  // fault, so they read as invalid input rather than as a broken app.
  const invalid = [
    'refused_scheme',
    'refused_host',
    'invalid_url',
    'not_html',
    'too_large',
    'empty_page',
    'unsupported',
  ];
  return fail(invalid.includes(code) ? 'invalid_input' : 'storage_failed', raw);
}

async function snapshot(
  url: string,
): Promise<CommandResult<{ name: string; markdown: string; finalUrl: string }>> {
  let page;
  try {
    page = await web.fetchPage(url);
  } catch (error) {
    return fetchFailure(error);
  }

  try {
    const article = extractPage(page.html, page.finalUrl);
    return ok({
      name: snapshotFilename(article.title),
      markdown: snapshotMarkdown(article, page.finalUrl, new Date().toISOString()),
      finalUrl: page.finalUrl,
    });
  } catch (error) {
    return fetchFailure(error);
  }
}

export async function attachWebLinkCommand(
  input: AttachWebLinkInput,
  _context: CommandContext = USER,
): Promise<CommandResult<Attachment>> {
  const parsed = LinkInput.safeParse({ ...input, url: normaliseUrl(input.url) });
  if (!parsed.success) {
    return fail('invalid_input', 'invalid link', parsed.error.issues);
  }

  const taken = await snapshot(parsed.data.url);
  if (!taken.ok) return taken;

  const fetchedAt = new Date().toISOString();
  const blob = new Blob([taken.value.markdown], { type: 'text/markdown' });

  try {
    const asset = await assets.put(blob, { mime: 'text/markdown' });
    const attachment = AttachmentSchema.parse({
      id: newId(),
      noteId: parsed.data.noteId,
      assetId: asset.id,
      name: taken.value.name,
      createdAt: fetchedAt,
      annotations: [],
      // The address that answered, not the one that was typed: that is what a
      // later re-fetch should ask for, and what the citation should credit.
      url: taken.value.finalUrl,
      fetchedAt,
    });
    await library.upsertAttachment(attachment);
    attachmentsChanged();
    return ok(attachment);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

/**
 * Take the snapshot again.
 *
 * A new asset and a new `fetchedAt` on the same attachment row, so the note
 * keeps pointing at one thing rather than accumulating a copy per visit. The
 * old asset is left to the garbage collector that already sweeps unreferenced
 * blobs.
 */
export async function refetchWebLinkCommand(
  attachment: Attachment,
  _context: CommandContext = USER,
): Promise<CommandResult<Attachment>> {
  if (!attachment.url) {
    return fail('invalid_input', 'that attachment is a file, not a link');
  }

  const taken = await snapshot(attachment.url);
  if (!taken.ok) return taken;

  const fetchedAt = new Date().toISOString();
  const blob = new Blob([taken.value.markdown], { type: 'text/markdown' });

  try {
    const asset = await assets.put(blob, { mime: 'text/markdown' });
    const updated = AttachmentSchema.parse({
      ...attachment,
      assetId: asset.id,
      name: taken.value.name,
      url: taken.value.finalUrl,
      fetchedAt,
      // Highlights were anchored to the old text and would point at the wrong
      // words in a page that has since been edited. Dropping them is honest;
      // keeping them would be a quiet lie about what was highlighted.
      annotations: [],
    });
    await library.upsertAttachment(updated);
    attachmentsChanged();
    return ok(updated);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}
