/**
 * Wikipedia's search excerpt, reduced to something the result list can draw.
 *
 * The API answers with a sentence containing markup — `…président de la
 * <span class="searchmatch">HATVP</span> depuis…` — and that markup is the
 * useful part: it says which words matched, which is how you tell two similar
 * titles apart at a glance.
 *
 * It is parsed rather than pattern-matched, and the output is a string in the
 * `<mark>` form `HighlightedSnippet` already renders as elements. So the same
 * rule holds here as everywhere else in this app: text that arrived from
 * outside is rebuilt as React children and never becomes markup. `DOMParser`
 * builds a tree without executing anything — scripts do not run and `<img>`
 * does not fetch — which is what makes reading the tree safe at all.
 */

/** How much of an excerpt is worth showing before it stops being a glance. */
const MAX_LENGTH = 180;

interface Run {
  text: string;
  match: boolean;
}

/** The excerpt as alternating plain and matched runs, in reading order. */
function runs(excerpt: string): Run[] {
  const body = new DOMParser().parseFromString(excerpt, 'text/html').body;
  const found: Run[] = [];

  const walk = (node: Node, match: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text) found.push({ text, match });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    // Nested markup inside a match stays a match: the flag travels down the
    // tree rather than being read off one element.
    const inside = match || element.classList.contains('searchmatch');
    for (const child of Array.from(element.childNodes)) walk(child, inside);
  };
  for (const child of Array.from(body.childNodes)) walk(child, false);

  return found;
}

export function excerptSnippet(excerpt: string): string {
  // Collapse the newlines and runs of spaces wiki markup leaves behind: a
  // snippet is one line, and should be measured as one.
  const found = runs(excerpt)
    .map((run) => ({ ...run, text: run.text.replace(/\s+/g, ' ') }))
    .filter((run) => run.text);
  if (found.length === 0) return '';

  found[0]!.text = found[0]!.text.trimStart();

  // Truncation works over the runs rather than over the finished string, so a
  // cut can never land inside a `<mark>` and leave the renderer half a marker.
  let length = 0;
  const kept: Run[] = [];
  let truncated = false;
  for (const run of found) {
    if (length + run.text.length <= MAX_LENGTH) {
      kept.push(run);
      length += run.text.length;
      continue;
    }
    const room = MAX_LENGTH - length;
    const head = run.text.slice(0, room);
    // Prefer a word boundary, but take a hard cut over dropping the run that
    // holds the match the student is scanning for.
    const space = head.lastIndexOf(' ');
    const text = (run.match || space <= 0 ? head : head.slice(0, space)).trimEnd();
    if (text) kept.push({ ...run, text });
    truncated = true;
    break;
  }

  const rendered = kept
    .map((run) => (run.match ? `<mark>${run.text}</mark>` : run.text))
    .join('')
    .trimEnd();

  return truncated ? `${rendered}…` : rendered;
}
