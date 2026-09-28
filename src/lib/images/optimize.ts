/**
 * Make an image cheaper to keep before it becomes an asset.
 *
 * A phone photo pasted into a lecture note is 4 000 px and 5 MB, is shown at
 * 640 px, and is copied into every backup forever. Capping the long edge and
 * re-encoding saves most of that with nothing visible lost. Re-encoding also
 * drops EXIF — including the GPS position a phone writes into every photo —
 * which is a privacy gain for a library that gets backed up and exported.
 *
 * The rules, in order of what they protect:
 *
 * - **Never worse than the original.** A result that is not clearly smaller is
 *   thrown away and the original stored, so a small screenshot is untouched.
 * - **Text stays sharp.** Screenshots and diagrams stay PNG; only an image
 *   whose pixels look photographic is encoded lossily (see `inspectPixels`).
 * - **Transparency survives.** An image with any transparent pixel stays PNG.
 * - **Nothing is animated or vector-drawn into a still.** GIF, SVG and anything
 *   the webview cannot decode are stored as they came.
 *
 * Planning is pure and unit-tested; the canvas half only executes a plan.
 */

export type ImageOptimization = 'off' | 'balanced' | 'small';

export const IMAGE_OPTIMIZATIONS: readonly ImageOptimization[] = [
  'off',
  'balanced',
  'small',
];

interface Preset {
  /** Longest edge, in pixels, after optimisation. */
  maxEdge: number;
  /** Lossy quality, 0–1. */
  quality: number;
}

/** Balanced keeps a full-width retina slide legible when zoomed; small is for a
 * student who pastes a lot of photos and cares about the backup size. */
export const IMAGE_PRESETS: Record<Exclude<ImageOptimization, 'off'>, Preset> = {
  balanced: { maxEdge: 2000, quality: 0.85 },
  small: { maxEdge: 1280, quality: 0.75 },
};

/** Below this an image within the size cap is not worth decoding at all. */
const SMALL_ENOUGH_BYTES = 150 * 1024;

/** A re-encode must save at least this share of the original to be kept. */
const MIN_SAVING = 0.1;

/**
 * More distinct colours than this, in a sample of the pixels, means the image
 * is photographic. Screenshots, slides and diagrams are flat colour plus the
 * greys of anti-aliased text — a few hundred colours at most — and are what
 * lossy compression smears. Deciding from the pixels rather than the format is
 * what sends a photo that arrived as a PNG to WebP and keeps a screenshot that
 * arrived as a PNG sharp. (Comparing the two encodes' sizes was tried first and
 * fails: WebKit's and Chromium's canvas PNG encoders are loose enough that a
 * page of text looks photographic by that measure.)
 */
const PHOTO_COLOURS = 4096;

/** Pixels sampled for the colour count — enough to see a photo's noise, few
 * enough to stay a millisecond or two on a 2000 px image. */
const COLOUR_SAMPLES = 65_536;

/** Formats a canvas can decode and a still re-encode loses nothing that
 * matters. GIF may be animated; SVG is not pixels. */
const OPTIMIZABLE = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/avif',
]);

/** Formats that cannot carry transparency, so there is no alpha to look for. */
const OPAQUE = new Set(['image/jpeg', 'image/jpg', 'image/bmp']);

export interface ImageFacts {
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

export type ImagePlan =
  | { action: 'keep' }
  | {
      action: 'encode';
      width: number;
      height: number;
      /** Whether the pixels must be checked for transparency first. */
      checkAlpha: boolean;
      quality: number;
    };

/** Whether an image is worth decoding under this setting, from its type and
 * size alone — the cheap check that runs before any decode. */
export function mayOptimize(mime: string, setting: ImageOptimization): boolean {
  return setting !== 'off' && OPTIMIZABLE.has(mime.toLowerCase());
}

/** What to do with a decoded image. */
export function planImageOptimization(
  facts: ImageFacts,
  setting: ImageOptimization,
): ImagePlan {
  if (setting === 'off' || !mayOptimize(facts.mime, setting)) return { action: 'keep' };
  const preset = IMAGE_PRESETS[setting];
  const longest = Math.max(facts.width, facts.height);
  if (!(longest > 0)) return { action: 'keep' };
  const oversized = longest > preset.maxEdge;
  // A JPEG or HEIC still goes through when it is large, even within the cap:
  // that is the photo with the camera's GPS in it, and the recompression pays.
  if (!oversized && facts.bytes < SMALL_ENOUGH_BYTES) return { action: 'keep' };
  const scale = oversized ? preset.maxEdge / longest : 1;
  return {
    action: 'encode',
    width: Math.max(1, Math.round(facts.width * scale)),
    height: Math.max(1, Math.round(facts.height * scale)),
    checkAlpha: !OPAQUE.has(facts.mime.toLowerCase()),
    quality: preset.quality,
  };
}

export interface PixelFacts {
  transparent: boolean;
  photographic: boolean;
}

/** Read transparency and colour variety from RGBA pixels. */
export function inspectPixels(data: ArrayLike<number>): PixelFacts {
  const pixels = Math.floor(data.length / 4);
  let transparent = false;
  for (let index = 3; index < data.length; index += 4) {
    if ((data[index] ?? 255) < 255) {
      transparent = true;
      break;
    }
  }
  const step = Math.max(1, Math.floor(pixels / COLOUR_SAMPLES));
  const colours = new Set<number>();
  for (let pixel = 0; pixel < pixels; pixel += step) {
    const at = pixel * 4;
    colours.add(
      ((data[at] ?? 0) << 16) | ((data[at + 1] ?? 0) << 8) | (data[at + 2] ?? 0),
    );
    if (colours.size > PHOTO_COLOURS) break;
  }
  return { transparent, photographic: colours.size > PHOTO_COLOURS };
}

/** Lossy for a photograph without transparency, lossless for everything else.
 * A source that was already lossy and cannot carry alpha stays lossy — a PNG
 * of a JPEG only grows. */
export function encodingFor(
  plan: Extract<ImagePlan, { action: 'encode' }>,
  pixels: PixelFacts | null,
): 'lossy' | 'lossless' {
  if (!plan.checkAlpha || !pixels) return 'lossy';
  return !pixels.transparent && pixels.photographic ? 'lossy' : 'lossless';
}

/** The encode, or the original when it is not clearly smaller. */
export function keepSmaller(original: Blob, encoded: Blob | undefined): Blob {
  return encoded && encoded.size <= original.size * (1 - MIN_SAVING) ? encoded : original;
}

/**
 * Optimise `blob` under `setting`, or return it unchanged.
 *
 * Never throws: an image the webview cannot decode, or a runtime without a
 * canvas (the test environment), stores the original — losing a pasted image
 * to an optimisation that was only meant to save space would be backwards.
 */
export async function optimizeImage(
  blob: Blob,
  setting: ImageOptimization,
): Promise<Blob> {
  const mime = blob.type.toLowerCase();
  if (!mayOptimize(mime, setting)) return blob;
  if (typeof createImageBitmap !== 'function') return blob;

  let bitmap: ImageBitmap | undefined;
  try {
    // `from-image` applies the EXIF rotation before the EXIF is dropped, so a
    // portrait phone photo does not come out on its side.
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const plan = planImageOptimization(
      { mime, bytes: blob.size, width: bitmap.width, height: bitmap.height },
      setting,
    );
    if (plan.action === 'keep') return blob;

    const canvas = makeCanvas(plan.width, plan.height);
    const context = canvas?.getContext('2d') as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
    if (!canvas || !context) return blob;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);

    const pixels = plan.checkAlpha
      ? inspectPixels(context.getImageData(0, 0, plan.width, plan.height).data)
      : null;
    const encoded =
      encodingFor(plan, pixels) === 'lossy'
        ? await encodeLossy(canvas, plan.quality)
        : await encode(canvas, 'image/png');
    return keepSmaller(blob, encoded);
  } catch {
    return blob;
  } finally {
    bitmap?.close();
  }
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): AnyCanvas | null {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function encode(
  canvas: AnyCanvas,
  type: string,
  quality?: number,
): Promise<Blob | undefined> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve) =>
    canvas.toBlob((result) => resolve(result ?? undefined), type, quality),
  );
}

/**
 * WebP where the webview can write it, JPEG where it cannot. A canvas asked
 * for a type it cannot encode silently returns a PNG, so the answer's type is
 * the test — WebKit reads WebP but has not always written it.
 */
async function encodeLossy(
  canvas: AnyCanvas,
  quality: number,
): Promise<Blob | undefined> {
  const webp = await encode(canvas, 'image/webp', quality);
  if (webp?.type === 'image/webp') return webp;
  const jpeg = await encode(canvas, 'image/jpeg', quality);
  return jpeg?.type === 'image/jpeg' ? jpeg : undefined;
}
