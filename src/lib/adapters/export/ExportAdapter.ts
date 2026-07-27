/**
 * Export sink.
 *
 * Rendering — doc JSON → HTML → Markdown/PDF/DOCX — happens in shared TypeScript
 * under `src/lib/export/`, because that is what keeps the four formats faithful
 * to one another. This adapter only covers the part that genuinely differs by
 * platform: where the bytes land.
 */
/**
 * What is being written. The desktop writer treats every format the same — it
 * is bytes to a path — but the value travels with the request so a platform
 * that needs to care can, and so a log line says "anki" rather than "markdown"
 * for a deck. `anki` and `audio` come from the study features in Phase G.
 */
export type ExportFormat =
  'markdown' | 'html' | 'pdf' | 'docx' | 'backup' | 'anki' | 'audio';

/** The formats the note export pipeline renders. The others are produced by
 * features that build their own bytes and only borrow the sink. */
export type NoteExportFormat = Exclude<ExportFormat, 'backup' | 'anki' | 'audio'>;

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
}
