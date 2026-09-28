import { describe, expect, it } from 'vitest';
import {
  encodingFor,
  inspectPixels,
  keepSmaller,
  optimizeImage,
  planImageOptimization,
  type ImageFacts,
} from './optimize';

const KB = 1024;
const MB = 1024 * KB;

const photo: ImageFacts = {
  mime: 'image/jpeg',
  bytes: 5 * MB,
  width: 4032,
  height: 3024,
};

function blobOf(bytes: number, type: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

describe('planImageOptimization', () => {
  it('scales a phone photo to the preset edge, keeping its shape', () => {
    const plan = planImageOptimization(photo, 'balanced');
    expect(plan).toMatchObject({ action: 'encode', width: 2000, height: 1500 });
  });

  it('scales harder under the small preset', () => {
    expect(planImageOptimization(photo, 'small')).toMatchObject({
      width: 1280,
      height: 960,
    });
  });

  it('scales a portrait image by its long edge', () => {
    const plan = planImageOptimization(
      { ...photo, width: 3024, height: 4032 },
      'balanced',
    );
    expect(plan).toMatchObject({ width: 1500, height: 2000 });
  });

  it('does nothing when switched off', () => {
    expect(planImageOptimization(photo, 'off')).toEqual({ action: 'keep' });
  });

  it('leaves a small image within the cap alone', () => {
    expect(
      planImageOptimization(
        { mime: 'image/png', bytes: 80 * KB, width: 800, height: 600 },
        'balanced',
      ),
    ).toEqual({ action: 'keep' });
  });

  it('recompresses a heavy photo even within the cap, at its own size', () => {
    expect(
      planImageOptimization(
        { mime: 'image/jpeg', bytes: 2 * MB, width: 1600, height: 1200 },
        'balanced',
      ),
    ).toMatchObject({ action: 'encode', width: 1600, height: 1200 });
  });

  it('never touches animated or vector formats', () => {
    for (const mime of ['image/gif', 'image/svg+xml']) {
      expect(planImageOptimization({ ...photo, mime }, 'small')).toEqual({
        action: 'keep',
      });
    }
  });

  it('looks for transparency only where a format can carry it', () => {
    expect(planImageOptimization(photo, 'balanced')).toMatchObject({
      checkAlpha: false,
    });
    expect(
      planImageOptimization({ ...photo, mime: 'image/png' }, 'balanced'),
    ).toMatchObject({ checkAlpha: true });
  });
});

/** RGBA pixels, one colour each, from a colour function. */
function pixels(
  count: number,
  colour: (index: number) => [number, number, number, number],
) {
  const data = new Uint8ClampedArray(count * 4);
  for (let index = 0; index < count; index += 1) data.set(colour(index), index * 4);
  return data;
}

describe('inspectPixels', () => {
  it('reads a page of text as a graphic, not a photo', () => {
    // White, black and the greys of anti-aliasing.
    const text = pixels(100_000, (index) => {
      const grey = (index * 7) % 256;
      return [grey, grey, grey, 255];
    });
    expect(inspectPixels(text)).toEqual({ transparent: false, photographic: false });
  });

  it('reads sensor noise as a photo', () => {
    const photo = pixels(100_000, (index) => [
      (index * 31) % 256,
      (index * 17) % 256,
      (index * 7) % 251,
      255,
    ]);
    expect(inspectPixels(photo).photographic).toBe(true);
  });

  it('notices a single transparent pixel', () => {
    const cut = pixels(1_000, (index) => [255, 0, 0, index === 999 ? 0 : 255]);
    expect(inspectPixels(cut).transparent).toBe(true);
  });
});

describe('encodingFor', () => {
  const pngPlan = planImageOptimization({ ...photo, mime: 'image/png' }, 'balanced');
  const jpegPlan = planImageOptimization(photo, 'balanced');
  if (pngPlan.action !== 'encode' || jpegPlan.action !== 'encode') throw new Error();

  it('keeps a screenshot lossless', () => {
    expect(encodingFor(pngPlan, { transparent: false, photographic: false })).toBe(
      'lossless',
    );
  });

  it('sends a photo that arrived as a PNG to a lossy format', () => {
    expect(encodingFor(pngPlan, { transparent: false, photographic: true })).toBe(
      'lossy',
    );
  });

  it('keeps transparency, even in a photo', () => {
    expect(encodingFor(pngPlan, { transparent: true, photographic: true })).toBe(
      'lossless',
    );
  });

  it('keeps a JPEG lossy: a PNG of it would only grow', () => {
    expect(encodingFor(jpegPlan, null)).toBe('lossy');
  });
});

describe('keepSmaller', () => {
  const original = blobOf(1000, 'image/png');

  it('takes a clearly smaller encode', () => {
    const encoded = blobOf(400, 'image/webp');
    expect(keepSmaller(original, encoded)).toBe(encoded);
  });

  it('keeps the original when the result is not clearly smaller', () => {
    expect(keepSmaller(original, blobOf(950, 'image/png'))).toBe(original);
  });

  it('keeps the original when nothing could be encoded', () => {
    expect(keepSmaller(original, undefined)).toBe(original);
  });
});

describe('optimizeImage', () => {
  it('stores the original where there is no canvas to decode with', async () => {
    const blob = blobOf(3 * MB, 'image/jpeg');
    await expect(optimizeImage(blob, 'balanced')).resolves.toBe(blob);
  });
});
