/**
 * Shared vocabulary for the command layer.
 *
 * Commands are the *only* way anything mutates the library — the UI, the AI
 * features, and the MCP server all call the same functions. That is what makes
 * "everything the UI can do to a note, the MCP server can do" (PRD §4,
 * principle 6) true by construction rather than by discipline.
 */
import i18n from '@/lib/i18n';

/** Who asked. Decides the snapshot `cause` and whether the agent-activity
 * indicator lights up — an edit that arrived over MCP should never look
 * identical to one the student typed. */
export type CommandSource = 'user' | 'ai' | 'agent';

export interface CommandContext {
  source: CommandSource;
  /** Agent name from the MCP `initialize` handshake, for the activity log. */
  agentName?: string;
  /** Internal override for writes such as history restore. */
  snapshotCause?: 'auto' | 'session' | 'restore' | 'ai' | 'agent';
  /** Groups every pre-edit snapshot created by one in-app agent run. */
  agentRunId?: string;
  /** Cooperative cancellation for multi-step agent tool handlers. */
  signal?: AbortSignal;
}

export const USER: CommandContext = { source: 'user' };

export type CommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CommandErrorCode; message: string; details?: unknown };

export type CommandErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'storage_failed'
  | 'not_supported'
  /** The user stopped it. Not a failure: nothing went wrong and there is
   * nothing to tell them, so every surface reads this as "say nothing". */
  | 'cancelled';

export function ok<T>(value: T): CommandResult<T> {
  return { ok: true, value };
}

export function fail<T>(
  code: CommandErrorCode,
  message: string,
  details?: unknown,
): CommandResult<T> {
  if (!i18n.language.startsWith('fr')) return { ok: false, code, message, details };
  const translated =
    /cancelled|canceled/i.test(message)
      ? i18n.t('error.cancelled')
      : /^no note |open a note/i.test(message)
        ? i18n.t('error.noteRequired')
        : /^no course /i.test(message)
          ? i18n.t('error.courseMissing')
          : /^no section /i.test(message)
            ? i18n.t('error.sectionMissing')
            : /^no snapshot /i.test(message)
              ? i18n.t('error.snapshotMissing')
              : /nothing|empty|choose|invalid|required/i.test(message)
                ? i18n.t('error.invalidInput')
                : /phase [A-Z]/i.test(message)
                  ? i18n.t('error.notAvailable')
                  : message;
  return { ok: false, code, message: translated, details };
}

export function cancelledIfRequested<T>(
  context: CommandContext,
): CommandResult<T> | null {
  return context.signal?.aborted ? fail('cancelled', 'cancelled') : null;
}
