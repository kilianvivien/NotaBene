/**
 * Find-in-document for the previews that render to the DOM — DOCX, ODT,
 * Markdown, RTF and plain text.
 *
 * Matches are painted with the CSS custom highlight registry rather than by
 * wrapping text in elements: `docx-preview` positions its output to the
 * millimetre, and inserting a `<mark>` into that layout moves the page under
 * the reader. Highlights are drawn over the text and change nothing beneath
 * them. Where the registry is missing, navigation still works and only the
 * paint is lost.
 *
 * The PDF reader keeps its own search: a PDF has no DOM to walk, and its
 * matches live on pages that have not been rendered yet.
 */
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

const ALL = 'nb-find';
const CURRENT = 'nb-find-current';
/**
 * The tints the two highlights paint with are custom properties that only have
 * values while this is set. Removing a highlight from the registry does not
 * repaint on WebKit — the entry goes and the marks stay, all over a document
 * whose search was closed — but changing a custom property invalidates paint
 * through the ordinary style path, which every engine gets right.
 */
const ACTIVE = 'nbFind';

interface TextRun {
  node: Text;
  start: number;
}

interface Position {
  node: Text;
  offset: number;
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function'
    ? CSS.highlights
    : null;
}

/**
 * Mutate a registered highlight instead of replacing or deleting it. WebKit
 * reliably invalidates paint for `Highlight.clear()`, while removing an entry
 * from `CSS.highlights` can leave its last pixels on screen. Keeping two empty
 * highlights registered costs nothing and makes clearing a real paint update.
 */
function replaceHighlight(
  registry: HighlightRegistry,
  name: string,
  ranges: Range[],
): void {
  const highlight = registry.get(name);
  if (!highlight) {
    registry.set(name, new Highlight(...ranges));
    return;
  }
  highlight.clear();
  for (const range of ranges) highlight.add(range);
}

/** Every text node under `root`, in reading order, with its running offset. */
function textRuns(root: HTMLElement): { runs: TextRun[]; text: string } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const runs: TextRun[] = [];
  let text = '';
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue ?? '';
    if (value) {
      runs.push({ node: node as Text, start: text.length });
      text += value;
    }
    node = walker.nextNode();
  }
  return { runs, text };
}

function locate(runs: TextRun[], offset: number): Position | null {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const run = runs[middle];
    if (!run) break;
    const end = run.start + (run.node.nodeValue?.length ?? 0);
    if (offset < run.start) high = middle - 1;
    else if (offset >= end) low = middle + 1;
    else return { node: run.node, offset: offset - run.start };
  }
  const last = runs[runs.length - 1];
  return last ? { node: last.node, offset: last.node.nodeValue?.length ?? 0 } : null;
}

function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const { runs, text } = textRuns(root);
  const haystack = text.toLocaleLowerCase();
  const ranges: Range[] = [];
  let cursor = haystack.indexOf(needle);
  while (cursor >= 0) {
    const from = locate(runs, cursor);
    const to = locate(runs, cursor + needle.length - 1);
    if (from && to) {
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset + 1);
      ranges.push(range);
    }
    cursor = haystack.indexOf(needle, cursor + needle.length);
  }
  return ranges;
}

/**
 * Paints matches inside an already-rendered container and returns how many
 * there were. The PDF reader counts its own matches — it searches pages it has
 * not drawn yet — but once a page is on screen its text layer is a DOM like any
 * other, and a search that highlights nothing on the page it just jumped to is
 * half a search.
 */
export function paintDocumentMatches(
  container: HTMLElement | null,
  query: string,
  current = -1,
): number {
  const registry = highlightRegistry();
  if (!registry) return 0;
  const ranges = container ? findRanges(container, query) : [];
  if (!ranges.length) {
    clearDocumentMatches();
    return 0;
  }
  document.documentElement.dataset[ACTIVE] = '';
  replaceHighlight(registry, ALL, ranges);
  const focused = ranges[current];
  replaceHighlight(registry, CURRENT, focused ? [focused] : []);
  return ranges.length;
}

/**
 * Deleting or replacing a highlight is not enough on WebKit: the registry
 * changes, but the old paint can stay. Mutating each registered Highlight to
 * empty invalidates that paint through the API path WebKit handles correctly.
 */
export function clearDocumentMatches(): void {
  delete document.documentElement.dataset[ACTIVE];
  const registry = highlightRegistry();
  if (!registry) return;
  replaceHighlight(registry, ALL, []);
  replaceHighlight(registry, CURRENT, []);
}

export interface DocumentSearch {
  count: number;
  /** Zero-based, or -1 when nothing matches. */
  index: number;
  step(direction: -1 | 1): void;
}

export function useDocumentSearch(
  container: RefObject<HTMLElement | null>,
  query: string,
  active: boolean,
): DocumentSearch {
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(-1);
  /** Bumped when the preview finishes rendering, so a query set while a
   * document was still loading finds it once it arrives. */
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const element = container.current;
    if (!active || !element) return;
    const observer = new MutationObserver(() => setRevision((current) => current + 1));
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [active, container]);

  useEffect(() => {
    const element = container.current;
    if (!active || !element || !query.trim()) {
      setRanges([]);
      setIndex(-1);
      return;
    }
    const found = findRanges(element, query);
    setRanges(found);
    setIndex(found.length ? 0 : -1);
  }, [active, container, query, revision]);

  useEffect(() => {
    const registry = highlightRegistry();
    if (!registry) return;
    if (!ranges.length) {
      clearDocumentMatches();
      return;
    }
    document.documentElement.dataset[ACTIVE] = '';
    replaceHighlight(registry, ALL, ranges);
    const current = ranges[index];
    replaceHighlight(registry, CURRENT, current ? [current] : []);
  }, [index, ranges]);

  useEffect(() => clearDocumentMatches, []);

  useEffect(() => {
    const current = ranges[index];
    // A collapsed range has no box to scroll to, and a range's own parent is
    // the only node guaranteed to be laid out.
    const anchor = current?.startContainer.parentElement;
    anchor?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [index, ranges]);

  const step = useCallback(
    (direction: -1 | 1) => {
      setIndex((current) => {
        if (!ranges.length) return -1;
        return (current + direction + ranges.length) % ranges.length;
      });
    },
    [ranges.length],
  );

  return useMemo(
    () => ({ count: ranges.length, index, step }),
    [index, ranges.length, step],
  );
}
