/**
 * Reading back a rendered mind map.
 *
 * `layout.ts` writes the SVG; this reads the two things every consumer needs
 * from the string afterwards — how big it is, and how to point an `<img>` at
 * it. Both were duplicated at three call sites, and the size in particular is
 * the kind of thing that gets re-derived slightly differently each time.
 */

export interface SvgSize {
  width: number;
  height: number;
}

/** What a map falls back to when the string carries no dimensions at all. Only
 * reachable for an SVG this app did not write, so it exists to keep a viewer
 * usable rather than to be correct. */
const FALLBACK: SvgSize = { width: 1000, height: 700 };

const VIEW_BOX = /viewBox="\s*([-\d.]+)[,\s]+([-\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*"/;
const WIDTH = /\bwidth="([\d.]+)(?:px)?"/;
const HEIGHT = /\bheight="([\d.]+)(?:px)?"/;

/**
 * Intrinsic size, from the `viewBox` first.
 *
 * The `viewBox` is the authority: `width`/`height` are a presentation hint and
 * may be a percentage or absent, whereas the third and fourth `viewBox` numbers
 * are always the coordinate extent — which is what a zoom has to be a multiple
 * of for 100% to mean 1:1.
 */
export function svgSize(svg: string): SvgSize {
  const viewBox = VIEW_BOX.exec(svg);
  if (viewBox) {
    const width = Number(viewBox[3]);
    const height = Number(viewBox[4]);
    if (width > 0 && height > 0) return { width, height };
  }

  const width = Number(WIDTH.exec(svg)?.[1]);
  const height = Number(HEIGHT.exec(svg)?.[1]);
  if (width > 0 && height > 0) return { width, height };

  return FALLBACK;
}

/**
 * An SVG string as something `<img src>` accepts.
 *
 * `encodeURIComponent` rather than base64: it survives the `#` in every colour
 * literal the renderer emits, which would otherwise be read as a fragment and
 * truncate the document.
 */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
