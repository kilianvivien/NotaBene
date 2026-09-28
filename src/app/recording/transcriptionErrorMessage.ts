/**
 * A failed transcription in the student's language. The command layer
 * reports an `ASR_*` code (and, for a window, where in the lecture it
 * failed); the words are chosen here, at the surface.
 */
import type { TFunction } from 'i18next';
import { formatOffset } from '@/lib/recording/anchors';
import type { TranscriptionFailure } from '@/lib/state/transcriptionStore';

export function transcriptionErrorMessage(
  failure: TranscriptionFailure,
  t: TFunction,
): string {
  const key = failure.code ? `transcription.error.${failure.code}` : null;
  const detail = failure.message.replace(/^ASR_[A-Z_]+:?\s*/, '');
  const base =
    key && t(key, { detail, defaultValue: '' })
      ? t(key, { detail })
      : failure.code
        ? t('transcription.error.generic')
        : failure.message || t('transcription.error.generic');
  return failure.window
    ? `${base} ${t('transcription.failedAt', {
        start: formatOffset(failure.window.startMs),
        end: formatOffset(failure.window.endMs),
      })}`
    : base;
}
