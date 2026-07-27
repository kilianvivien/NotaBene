/**
 * Export sink.
 *
 * Rendering — doc JSON → HTML → Markdown/PDF/DOCX — happens in shared TypeScript
 * under `src/lib/export/`, because that is what keeps the four formats faithful
 * to one another. This adapter only covers the part that genuinely differs by
 * platform: where the bytes land, and who can print a PDF.
 */
export type ExportFormat = 'markdown' | 'html' | 'pdf' | 'docx';

export interface ExportFile {
  /** Path relative to the export root, e.g. `Analysis I/lecture-3.md`. */
  path: string;
  contents: Blob;
}

export interface ExportRequest {
  format: ExportFormat;
  files: ExportFile[];
  /** Absolute destination. Under Tauri this is user-chosen; in the browser it
   * is ignored and the bundle downloads instead. */
  destination?: string;
  /** Multi-file exports zip rather than scattering files (Calqo pattern). */
  zip?: boolean;
  suggestedName?: string;
}

export interface ExportResult {
  ok: boolean;
  /** Where the output actually landed, when the platform can say. */
  path?: string;
  error?: string;
}

export interface ExportAdapter {
  write(request: ExportRequest): Promise<ExportResult>;
  /** Render print-ready HTML to a PDF. Separate from `write` because it needs
   * a real print engine, which the browser only exposes via `window.print`. */
  printToPdf(html: string, destination: string): Promise<ExportResult>;
}
