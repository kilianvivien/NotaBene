/**
 * Text folding, matched to the index.
 *
 * SQLite's `notes_fts` is built with `unicode61 remove_diacritics 2`, so
 * `résumé` and `resume` are the same token there. Anything that compares text
 * to what FTS5 would have matched — the in-memory adapter's ranking, keyword
 * derivation for retrieval — has to fold the same way, or a French note answers
 * on the desktop build and not in `pnpm dev`.
 */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();
}
