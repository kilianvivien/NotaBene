import type { AiImage } from '@/lib/ai/protocols';

/** Bound the upload without changing the original stored asset. Canvas also
 * normalises formats (HEIC, SVG, GIF…) to a provider-readable still image. */
export async function imageForVision(blob: Blob): Promise<AiImage> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error('image_decode_failed');
    const scale = Math.min(1, 2_000 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('image_decode_failed');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    if (!dataUrl.startsWith('data:image/jpeg;base64,'))
      throw new Error('image_decode_failed');
    return { mimeType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
