/**
 * One reading of an AI command's failure, for the three dialogs that can be
 * pointed at a whole selection.
 *
 * The selection limits report *why* in `details` rather than in the message,
 * because the message is assembled in the command layer and the student is
 * owed it in their own language. Everything else falls through to the message
 * the command produced, which `fail()` has already translated.
 */
import type { TFunction } from 'i18next';
import { MAX_AI_SOURCES, type AiSourceLimit } from '@/lib/ai';
import type { CommandResult } from '@/lib/commands';

export function aiErrorMessage(
  result: Extract<CommandResult<unknown>, { ok: false }>,
  t: TFunction,
): string {
  const limit = (result.details as { limit?: AiSourceLimit } | undefined)?.limit;
  if (limit) return t(`ai.limit_${limit}`, { max: MAX_AI_SOURCES });
  const aiReason = (result.details as { aiReason?: string } | undefined)?.aiReason;
  if (aiReason === 'context_too_large') return t('ai.error_context_too_large');
  if (aiReason === 'provider_refusal') {
    return t('ai.error_provider_refusal', { detail: result.message });
  }
  if (result.code === 'not_supported') {
    if (result.message === 'context_too_small') {
      return t('ai.unavailable_context_too_small');
    }
    if (result.message === 'provider_unavailable') {
      return t('ai.unavailable_provider_unavailable');
    }
    return t('ai.notConfiguredHint');
  }
  return result.message;
}
