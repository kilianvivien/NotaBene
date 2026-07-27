import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  mcp,
  secrets,
  type McpBridgeRequest,
  type McpClientId,
  type McpStatus,
} from '@/lib/adapters';
import { platformRuntime } from '@/lib/platform/runtime';
import { useSettingsStore } from './settingsStore';
import { useUiStore } from './uiStore';

const MCP_TOKEN_KEY = 'mcp-pairing-token';
const MAX_SESSION_ACTIVITIES = 100;

export type McpActivityStatus = 'running' | 'succeeded' | 'failed';

export interface McpActivity {
  id: string;
  method: string;
  agentName: string;
  noteId: string | null;
  noteTitle: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: McpActivityStatus;
  error: string | null;
}

interface McpState {
  status: McpStatus;
  pending: boolean;
  error: string | null;
  setupResult: string | null;
  activeRequests: number;
  activities: McpActivity[];

  initialize(): Promise<void>;
  refreshStatus(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  setPreferredPort(port: number): Promise<void>;
  rotateToken(): Promise<void>;
  writeClientConfig(client: McpClientId): Promise<string>;
  clearActivity(): void;
  beginActivity(request: McpBridgeRequest): string;
  finishActivity(
    id: string,
    outcome: { ok: boolean; result?: unknown; error?: string },
  ): void;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function pairingToken(rotate = false): Promise<string> {
  if (!rotate) {
    const existing = await secrets.get(MCP_TOKEN_KEY);
    if (existing) return existing;
  }
  const token = randomToken();
  await secrets.set(MCP_TOKEN_KEY, token);
  return token;
}

function requestTarget(request: McpBridgeRequest): {
  noteId: string | null;
  noteTitle: string | null;
} {
  if (!request.args || typeof request.args !== 'object') {
    return { noteId: null, noteTitle: null };
  }
  const args = request.args as Record<string, unknown>;
  const noteIds = Array.isArray(args.noteIds) ? args.noteIds : [];
  const moves = Array.isArray(args.moves) ? args.moves : [];
  const firstMove =
    moves[0] && typeof moves[0] === 'object'
      ? (moves[0] as Record<string, unknown>)
      : undefined;
  return {
    noteId:
      typeof args.noteId === 'string'
        ? args.noteId
        : typeof noteIds[0] === 'string'
          ? noteIds[0]
          : typeof firstMove?.noteId === 'string'
            ? firstMove.noteId
            : null,
    noteTitle: typeof args.title === 'string' ? args.title : null,
  };
}

function responseTarget(result: unknown): {
  noteId: string | null;
  noteTitle: string | null;
} {
  if (!result || typeof result !== 'object') {
    return { noteId: null, noteTitle: null };
  }
  const value = result as Record<string, unknown>;
  return {
    noteId: typeof value.id === 'string' ? value.id : null,
    noteTitle: typeof value.title === 'string' ? value.title : null,
  };
}

export const useMcpStore = create<McpState>()(
  immer((set, get) => ({
    status: { running: false, port: null, error: null },
    pending: false,
    error: null,
    setupResult: null,
    activeRequests: 0,
    activities: [],

    async initialize() {
      if (!platformRuntime.capabilities.mcpServer) return;
      await get().refreshStatus();
      if (useSettingsStore.getState().settings.mcpEnabled) {
        await get().setEnabled(true);
      }
    },

    async refreshStatus() {
      if (!platformRuntime.capabilities.mcpServer) return;
      try {
        const status = await mcp.status();
        set((state) => {
          state.status = status;
          state.error = status.error;
        });
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
      }
    },

    async setEnabled(enabled) {
      if (!platformRuntime.capabilities.mcpServer) {
        set((state) => {
          state.error = 'the MCP server requires the desktop app';
        });
        return;
      }
      set((state) => {
        state.pending = true;
        state.error = null;
        state.setupResult = null;
      });
      try {
        if (enabled) {
          const token = await pairingToken();
          const preferredPort = useSettingsStore.getState().settings.mcpPort;
          const port = await mcp.start(token, preferredPort);
          set((state) => {
            state.status = { running: true, port, error: null };
          });
        } else {
          await mcp.stop();
          set((state) => {
            state.status = { running: false, port: null, error: null };
          });
        }
        await useSettingsStore.getState().update({ mcpEnabled: enabled });
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
          state.status = { running: false, port: null, error: state.error };
        });
      } finally {
        set((state) => {
          state.pending = false;
        });
      }
    },

    async setPreferredPort(port) {
      if (!Number.isInteger(port) || port < 1024 || port > 65525) {
        set((state) => {
          state.error = 'preferred port must be between 1024 and 65525';
        });
        return;
      }
      await useSettingsStore.getState().update({ mcpPort: port });
      if (useSettingsStore.getState().settings.mcpEnabled) {
        await get().setEnabled(true);
      }
    },

    async rotateToken() {
      set((state) => {
        state.pending = true;
        state.error = null;
        state.setupResult = null;
      });
      try {
        const token = await pairingToken(true);
        if (get().status.running) {
          const preferredPort = useSettingsStore.getState().settings.mcpPort;
          const port = await mcp.start(token, preferredPort);
          set((state) => {
            state.status = { running: true, port, error: null };
          });
        }
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
      } finally {
        set((state) => {
          state.pending = false;
        });
      }
    },

    async writeClientConfig(client) {
      try {
        const { status } = get();
        if (!status.running || status.port === null) {
          throw new Error('start the MCP server before configuring a client');
        }
        const token = await pairingToken();
        const result = await mcp.writeClientConfig(client, status.port, token);
        set((state) => {
          // A custom result contains the bearer token. Return it directly to
          // the clipboard caller, but never retain it in inspectable UI state.
          state.setupResult = client === 'custom' ? 'custom' : result;
          state.error = null;
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => {
          state.error = message;
        });
        throw error;
      }
    },

    clearActivity() {
      set((state) => {
        state.activities = [];
      });
    },

    beginActivity(request) {
      const id = request.id;
      const target = requestTarget(request);
      set((state) => {
        state.activeRequests += 1;
        state.activities.unshift({
          id,
          method: request.method,
          agentName: request.client?.name ?? '',
          noteId: target.noteId,
          noteTitle: target.noteTitle,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          status: 'running',
          error: null,
        });
        if (state.activities.length > MAX_SESSION_ACTIVITIES) {
          state.activities.length = MAX_SESSION_ACTIVITIES;
        }
      });
      useUiStore.getState().setAgentBusy(true);
      return id;
    },

    finishActivity(id, outcome) {
      set((state) => {
        state.activeRequests = Math.max(0, state.activeRequests - 1);
        const activity = state.activities.find((entry) => entry.id === id);
        if (!activity) return;
        const target = responseTarget(outcome.result);
        activity.noteId ??= target.noteId;
        activity.noteTitle ??= target.noteTitle;
        activity.finishedAt = new Date().toISOString();
        activity.status = outcome.ok ? 'succeeded' : 'failed';
        activity.error = outcome.error ?? null;
      });
      useUiStore.getState().setAgentBusy(get().activeRequests > 0);
    },
  })),
);

export async function watchMcpStatus(): Promise<() => void> {
  if (!platformRuntime.capabilities.mcpServer) return () => {};
  return mcp.onStatus(() => {
    void useMcpStore.getState().refreshStatus();
  });
}
