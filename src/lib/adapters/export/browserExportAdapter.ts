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
    const file = request.files[0];
    if (!file) return { ok: false, error: 'nothing to export' };
    download(file.contents, request.suggestedName ?? file.path.split('/').pop() ?? 'export');
    return { ok: true };
  },

  async printToPdf(html): Promise<ExportResult> {
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
