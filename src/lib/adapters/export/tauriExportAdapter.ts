/** Desktop export: writes to a user-chosen path and zips bundles. */
import { invoke } from '@tauri-apps/api/core';
import { encodeBlobBase64 } from '@/lib/archive/base64';
import type { ExportAdapter, ExportRequest, ExportResult } from './ExportAdapter';

export const tauriExportAdapter: ExportAdapter = {
  async write(request: ExportRequest): Promise<ExportResult> {
    const files = await Promise.all(
      request.files.map(async (file) => ({
        path: file.path,
        data: await encodeBlobBase64(file.contents),
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
};
