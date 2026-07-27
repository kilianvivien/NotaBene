/**
 * An FTS5 snippet, with its match markers rendered as marks.
 *
 * SQLite hands back `…the <mark>limit</mark> of…`, which is a string containing
 * markup and not markup. It is split and rebuilt as elements rather than set as
 * `innerHTML`: the surrounding text is note content, and note content is the
 * one thing in this app that must never be able to become an element.
 */
export function HighlightedSnippet({ value }: { value: string }) {
  const parts = value.split(/(<mark>.*?<\/mark>)/g);
  return parts.map((part, index) =>
    part.startsWith('<mark>') && part.endsWith('</mark>') ? (
      <mark key={index} className="rounded-sm bg-[var(--nb-mark)] text-inherit">
        {part.slice(6, -7)}
      </mark>
    ) : (
      part
    ),
  );
}
