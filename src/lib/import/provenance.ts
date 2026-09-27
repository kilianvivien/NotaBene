/**
 * Where an imported note came from, read back out of its `importKey`.
 *
 * The key is `{source}:{key}`. For a folder source the key is the file's path
 * inside the folder, which is exactly what is worth showing; for Notion it is
 * the page's id, which is not, so only the source is named.
 */
export interface Provenance {
  /** `obsidian`, `markdownFolder`, `notion`, `document`, … */
  source: string;
  /** What to show as the origin, or `null` when the key is not readable. */
  path: string | null;
}

const PATHLESS = new Set(['notion']);

export function parseImportKey(importKey: string | null | undefined): Provenance | null {
  if (!importKey) return null;
  const separator = importKey.indexOf(':');
  if (separator <= 0) return null;
  const source = importKey.slice(0, separator);
  const path = importKey.slice(separator + 1);
  return { source, path: PATHLESS.has(source) || !path ? null : path };
}
