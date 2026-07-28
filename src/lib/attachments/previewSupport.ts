export type AttachmentPreviewKind =
  'image' | 'audio' | 'video' | 'pdf' | 'docx' | 'odt' | 'markdown' | 'rtf' | 'text';

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
]);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav']);
const VIDEO_EXTENSIONS = new Set(['m4v', 'mov', 'mp4', 'ogv', 'webm']);
const IMAGE_MIMES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);
const AUDIO_MIMES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
]);
const VIDEO_MIMES = new Set([
  'video/mp4',
  'video/ogg',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
]);

export const ATTACHMENT_ACCEPT = [
  '.avif',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.m4v',
  '.mov',
  '.mp4',
  '.ogv',
  '.webm',
  '.pdf',
  '.docx',
  '.odt',
  '.md',
  '.markdown',
  '.rtf',
  '.txt',
].join(',');

export function attachmentPreviewKind(
  name: string,
  mime: string,
): AttachmentPreviewKind | null {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_MIMES.has(mime) || IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_MIMES.has(mime) || AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_MIMES.has(mime) || VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    extension === 'docx'
  ) {
    return 'docx';
  }
  if (mime === 'application/vnd.oasis.opendocument.text' || extension === 'odt') {
    return 'odt';
  }
  if (
    mime === 'text/markdown' ||
    mime === 'text/x-markdown' ||
    extension === 'md' ||
    extension === 'markdown'
  ) {
    return 'markdown';
  }
  if (mime === 'application/rtf' || mime === 'text/rtf' || extension === 'rtf') {
    return 'rtf';
  }
  if (mime === 'text/plain' || extension === 'txt') return 'text';
  return null;
}

export function canPreviewAttachment(name: string, mime: string): boolean {
  return attachmentPreviewKind(name, mime) !== null;
}
