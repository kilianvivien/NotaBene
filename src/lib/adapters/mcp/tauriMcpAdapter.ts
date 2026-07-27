import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { McpAdapter, McpBridgeRequest, McpClientId, McpStatus } from './McpAdapter';

export const tauriMcpAdapter: McpAdapter = {
  start: (token: string, preferredPort: number) =>
    invoke<number>('mcp_start_server', { token, preferredPort }),
  stop: () => invoke('mcp_stop_server'),
  status: () => invoke<McpStatus>('mcp_server_status'),
  onStatus: (handler) =>
    listen<McpStatus>('notabene-mcp-status', (event) => handler(event.payload)),

  onRequest: (handler) =>
    listen<McpBridgeRequest>('notabene-mcp-request', (event) => handler(event.payload)),

  respond: (id, response) => invoke('mcp_bridge_respond', { id, response }),
  writeClientConfig: (client: McpClientId, port: number, token: string) =>
    invoke<string>('mcp_write_client_config', { client, port, token }),
};

/** The browser build has no loopback server to control. */
export const unavailableMcpAdapter: McpAdapter = {
  async start() {
    throw new Error('the MCP server requires the desktop app');
  },
  async stop() {},
  async status(): Promise<McpStatus> {
    return { running: false, port: null, error: null };
  },
  async onStatus() {
    return () => {};
  },
  async onRequest() {
    return () => {};
  },
  async respond() {},
  async writeClientConfig() {
    throw new Error('the MCP server requires the desktop app');
  },
};
