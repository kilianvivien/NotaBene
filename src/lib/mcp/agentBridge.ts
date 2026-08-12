/**
 * Webview half of the MCP bridge.
 *
 * The Rust server is an authenticated gateway and nothing more: it forwards
 * every tool call here as a `notabene-mcp-request` event, and this module runs
 * it through the same command layer the UI uses before answering. That is what
 * makes the PRD's promise literal — an agent write gets the same validation,
 * the same autosave, and the same version snapshot as a keystroke, because it
 * *is* the same code.
 *
 * Handlers live in `toolHandlers.ts`; this file owns transport and error shape.
 */
import { mcp, type McpBridgeRequest } from '@/lib/adapters';
import { useMcpStore } from '@/lib/state/mcpStore';
import { executeToolHandler, TOOL_HANDLERS, type ToolMethod } from './toolHandlers';

/** Structured error agents can branch on, rather than a bare string. */
export interface McpErrorPayload {
  code: string;
  message: string;
  recoverable: boolean;
  details?: unknown;
}

function isToolMethod(method: string): method is ToolMethod {
  return method in TOOL_HANDLERS;
}

/**
 * Start listening for forwarded tool calls. Returns an unsubscribe function;
 * calling it stops answering, which the Rust side sees as a timeout.
 */
export async function startAgentBridge(): Promise<() => void> {
  return mcp.onRequest((request) => {
    void handleRequest(request);
  });
}

async function handleRequest(request: McpBridgeRequest): Promise<void> {
  const activityId = useMcpStore.getState().beginActivity(request);
  let outcome: { ok: boolean; result?: unknown; error?: string } = {
    ok: false,
    error: 'request did not complete',
  };

  try {
    if (!isToolMethod(request.method)) {
      await respondError(request.id, {
        code: 'unknown_tool',
        message: `no such tool: ${request.method}`,
        recoverable: false,
      });
      outcome = { ok: false, error: `no such tool: ${request.method}` };
      return;
    }

    const result = await executeToolHandler(request.method, request.args, {
      source: 'agent',
      agentName: request.client?.name,
    });

    if (result.ok) {
      await mcp.respond(request.id, { ok: true, result: result.value });
      outcome = { ok: true, result: result.value };
    } else {
      await respondError(request.id, {
        code: result.code,
        message: result.message,
        // `not_found` and `invalid_input` are worth another attempt with
        // different arguments; a storage failure is not.
        recoverable:
          result.code === 'not_found' ||
          result.code === 'invalid_input' ||
          result.code === 'conflict',
        details: result.details,
      });
      outcome = { ok: false, error: result.message };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await respondError(request.id, {
      code: 'internal_error',
      message,
      recoverable: false,
    });
    outcome = { ok: false, error: message };
  } finally {
    useMcpStore.getState().finishActivity(activityId, outcome);
  }
}

async function respondError(id: string, error: McpErrorPayload): Promise<void> {
  await mcp.respond(id, { ok: false, error });
}
