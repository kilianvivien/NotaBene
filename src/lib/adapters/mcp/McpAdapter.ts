/**
 * Control surface for the embedded MCP server.
 *
 * The server itself is Rust (`src-tauri/src/mcp/`); this is only how the UI
 * starts it, reads its status, and writes the client config. Tool *execution*
 * does not come through here — it arrives as bridge events and is answered by
 * `src/lib/mcp/agentBridge.ts`, so agent writes take the same command path as
 * a keystroke (PRD §4, principle 6).
 */
export interface McpStatus {
  running: boolean;
  port: number | null;
  error: string | null;
}

/** Which MCP clients we can write a config file for, one click. */
export type McpClientId =
  'claude-code' | 'claude-desktop' | 'codex' | 'antigravity' | 'opencode' | 'custom';

/**
 * What the settings pane shows for each of them, and where the write lands.
 *
 * The path is here rather than only in Rust because the point of the pane is to
 * tell the student *what is about to be edited on their machine* before they
 * press the button. Writing to a config file unannounced is the kind of thing a
 * privacy-first app does not get to do, even helpfully. The shapes themselves
 * live in `src-tauri/src/mcp/setup.rs`; this is the label.
 */
export interface McpClientDefinition {
  id: Exclude<McpClientId, 'custom'>;
  label: string;
  /** Shown verbatim, with `~` unexpanded — it is a description, not a path the
   * app resolves. */
  path: string;
  /** i18n key for the one-line note under the row. */
  hintKey: string;
}

export const MCP_CLIENTS: McpClientDefinition[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    path: '~/.claude.json',
    hintKey: 'mcp.clientHint_claudeCode',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    path: '~/Library/Application Support/Claude/claude_desktop_config.json',
    hintKey: 'mcp.clientHint_claudeDesktop',
  },
  {
    id: 'codex',
    label: 'Codex',
    path: '~/.codex/config.toml',
    hintKey: 'mcp.clientHint_codex',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    path: '~/.gemini/antigravity/mcp_config.json',
    hintKey: 'mcp.clientHint_antigravity',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    path: '~/.config/opencode/opencode.json',
    hintKey: 'mcp.clientHint_opencode',
  },
];

/** One tool call forwarded from the Rust server. */
export interface McpBridgeRequest {
  id: string;
  method: string;
  args: unknown;
  client?: { name: string; version?: string };
}

export interface McpAdapter {
  start(token: string, preferredPort: number, scope: 'read' | 'write'): Promise<number>;
  stop(): Promise<void>;
  status(): Promise<McpStatus>;
  /** Subscribe to server lifecycle changes (bind, stop, unexpected failure). */
  onStatus(handler: (status: McpStatus) => void): Promise<() => void>;
  /** Subscribe to forwarded tool calls. Resolves to an unsubscribe function. */
  onRequest(handler: (request: McpBridgeRequest) => void): Promise<() => void>;
  /** Answer one forwarded tool call. Called by the agent bridge only. */
  respond(
    id: string,
    response: { ok: boolean; result?: unknown; error?: unknown },
  ): Promise<void>;
  /** Write (or preview) the client's MCP config entry. */
  writeClientConfig(client: McpClientId, port: number, token: string): Promise<string>;
}
