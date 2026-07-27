/** Desktop export: writes to a user-chosen path, zipping bundles, and drives
 * the Rust-side print engine for PDF. */
import { invoke } from '@tauri-apps/api/core';
import type { ExportAdapter, ExportRequest, ExportResult } from './ExportAdapter';

async function encode(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export const tauriExportAdapter: ExportAdapter = {
  async write(request: ExportRequest): Promise<ExportResult> {
    const files = await Promise.all(
      request.files.map(async (file) => ({
        path: file.path,
        data: await encode(file.contents),
      })),
    );
    return invoke<ExportResult>('export_write', {
      request: {
        format: request.format,
        destination: request.destination,
        zip: request.zip ?? false,
        suggestedName: request.suggestedName,
        files,
      },
    });
  },

  async printToPdf(html: string): Promise<ExportResult> {
    const frame = document.createElement('iframe');
    frame.style.cssText =
      'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none';
    frame.srcdoc = html;
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener('load', () => resolve(), { once: true }),
    );
    document.body.append(frame);
    await loaded;
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 60_000);
    return { ok: true };
  },
};
