import '@testing-library/jest-dom/vitest';
import '@/lib/i18n';

// jsdom does no layout, and leaves geometry off `Range`. ProseMirror measures
// the caret whenever a transaction scrolls it into view — TipTap's `focus()`
// does so on a timer, sometimes after the test that caused it has finished —
// and without these that surfaced as an unhandled `getClientRects` error that
// came and went with test timing. An empty rect is the honest answer here.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  const empty = (): DOMRect => new DOMRect(0, 0, 0, 0);
  Range.prototype.getBoundingClientRect = empty;
  Range.prototype.getClientRects = () =>
    Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
}
