/**
 * Shared vocabulary for the command layer.
 *
 * Commands are the *only* way anything mutates the library — the UI, the AI
 * features, and the MCP server all call the same functions. That is what makes
 * "everything the UI can do to a note, the MCP server can do" (PRD §4,
 * principle 6) true by construction rather than by discipline.
 */

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
  | 'not_supported';

export function ok<T>(value: T): CommandResult<T> {
  return { ok: true, value };
}

export function fail<T>(
  code: CommandErrorCode,
  message: string,
  details?: unknown,
): CommandResult<T> {
  return { ok: false, code, message, details };
}
