/** Browser export: single files download directly, bundles are unsupported
 * until the web build grows a zip path (Phase D). */
import type { ExportAdapter, ExportRequest, ExportResult } from './ExportAdapter';

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const browserExportAdapter: ExportAdapter = {
  async write(request: ExportRequest): Promise<ExportResult> {
    if (request.files.length === 0) return { ok: false, error: 'nothing to export' };
    if (request.files.length > 1 && !request.zip) {
      return { ok: false, error: 'multi-file export requires zip in the browser' };
    }
    const [file] = request.files;
    download(file.contents, request.suggestedName ?? file.path.split('/').pop()!);
    return { ok: true };
  },

  async printToPdf(): Promise<ExportResult> {
    // `window.print` cannot target a path, so the desktop build owns PDF.
    return { ok: false, error: 'PDF export requires the desktop app' };
  },
};
