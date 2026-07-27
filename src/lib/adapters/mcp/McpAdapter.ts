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
export type McpClientId = 'claude-code' | 'claude-desktop' | 'custom';

/** One tool call forwarded from the Rust server. */
export interface McpBridgeRequest {
  id: string;
  method: string;
  args: unknown;
  client?: { name: string; version?: string };
}

export interface McpAdapter {
  start(token: string, preferredPort: number): Promise<number>;
  stop(): Promise<void>;
  status(): Promise<McpStatus>;
  /** Subscribe to forwarded tool calls. Resolves to an unsubscribe function. */
  onRequest(handler: (request: McpBridgeRequest) => void): Promise<() => void>;
  /** Answer one forwarded tool call. Called by the agent bridge only. */
  respond(id: string, response: { ok: boolean; result?: unknown; error?: unknown }): Promise<void>;
  /** Write (or preview) the client's MCP config entry. */
  writeClientConfig(client: McpClientId, port: number, token: string): Promise<string>;
}
