import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These tests exist for one reason, and it is not coverage.
 *
 * Vision returns *no observations and no error* for an image carrying an
 * alpha channel, so a legible page comes back blank. A `<canvas>` is RGBA and
 * `toBlob` with no type writes an RGBA PNG — the default is the broken case.
 * If someone simplifies the call below, every scanned page silently imports
 * as empty and nothing fails.
 */
const getViewport = vi.fn(() => ({ width: 612, height: 792 }));
const render = vi.fn(() => ({ promise: Promise.resolve() }));
const getPage = vi.fn(async () => ({ getViewport, render }));
const destroy = vi.fn(async () => {});

vi.mock('@/lib/pdf/loadPdfjs', () => ({
  loadPdfjs: async () => ({
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 10, getPage }),
      destroy,
    }),
  }),
}));

const { rasterisePdfPages, pdfPageCount } = await import('./pdfPages');

/** What `toBlob` was asked for, per call. */
let requested: Array<{ type?: string; quality?: number }> = [];
let fillStyle: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  requested = [];
  fillStyle = null;
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        set fillStyle(value: string) {
          fillStyle = value;
        },
        fillRect: () => {},
      }),
      toBlob: (
        callback: (blob: Blob | null) => void,
        type?: string,
        quality?: number,
      ) => {
        requested.push({ type, quality });
        callback(new Blob(['image'], { type: type ?? 'image/png' }));
      },
    } as unknown as HTMLElement;
  });
});

/** jsdom's `Blob` has no `arrayBuffer()`; the webview's does. */
function pdfBlob(): Blob {
  return { arrayBuffer: async () => new ArrayBuffer(8) } as Blob;
}

async function rasterise(pages: number[], signal?: AbortSignal) {
  const seen: number[] = [];
  await rasterisePdfPages(
    pdfBlob(),
    pages,
    async ({ page }) => {
      seen.push(page);
    },
    signal,
  );
  return seen;
}

describe('rasterisePdfPages', () => {
  it('renders JPEG, never the canvas default', async () => {
    // The default is an RGBA PNG, which Vision reads as a blank page.
    await rasterise([1]);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.type).toBe('image/jpeg');
    expect(requested[0]?.quality).toBeGreaterThan(0.8);
  });

  it('paints the sheet white before drawing the page', async () => {
    // A PDF page has no background of its own. Without this, JPEG flattens
    // the transparent sheet to black — and black text on black is the other
    // way to import a blank page.
    await rasterise([1]);
    expect(fillStyle).toBe('#ffffff');
  });

  it('renders only the pages it was given, in order', async () => {
    expect(await rasterise([3, 1, 9])).toEqual([3, 1, 9]);
    expect(getPage).toHaveBeenCalledTimes(3);
  });

  it('skips a page number the document does not have', async () => {
    // The page list crosses IPC from a different parser; a number outside
    // the document must not throw the whole run away.
    expect(await rasterise([1, 99, 2])).toEqual([1, 2]);
  });

  it('stops at the next page when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await rasterise([1, 2, 3], controller.signal)).toEqual([]);
  });

  it('closes the document even when a page fails', async () => {
    getPage.mockRejectedValueOnce(new Error('broken page'));
    await expect(rasterise([1])).rejects.toThrow('broken page');
    expect(destroy).toHaveBeenCalled();
  });
});

describe('pdfPageCount', () => {
  it('counts pages without rendering any', async () => {
    expect(await pdfPageCount(pdfBlob())).toBe(10);
    expect(getPage).not.toHaveBeenCalled();
  });
});
