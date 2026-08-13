const PDF_SOURCE_PROTOCOL = 'notabene-pdf:';

export interface PdfSourceLink {
  attachmentId: string;
  page: number;
  annotationId?: string;
}

export function buildPdfSourceHref(source: PdfSourceLink): string {
  const query = new URLSearchParams({ page: String(source.page) });
  if (source.annotationId) query.set('annotation', source.annotationId);
  return `${PDF_SOURCE_PROTOCOL}${encodeURIComponent(source.attachmentId)}?${query}`;
}

export function parsePdfSourceHref(href: string): PdfSourceLink | null {
  if (!href.startsWith(PDF_SOURCE_PROTOCOL)) return null;
  const [rawId, rawQuery = ''] = href.slice(PDF_SOURCE_PROTOCOL.length).split('?');
  if (!rawId) return null;
  const page = Number(new URLSearchParams(rawQuery).get('page'));
  if (!Number.isInteger(page) || page < 1) return null;
  try {
    const annotationId = new URLSearchParams(rawQuery).get('annotation') ?? undefined;
    return { attachmentId: decodeURIComponent(rawId), page, annotationId };
  } catch {
    return null;
  }
}
