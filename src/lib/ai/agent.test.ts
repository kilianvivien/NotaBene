import { describe, expect, it, vi } from 'vitest';
import { AGENT_TOOL_NAMES, type AgentDecision } from '@/lib/schema';
import { TOOL_HANDLERS } from '@/lib/mcp/toolHandlers';
import { providerById } from './providers';
import type { ResolvedProvider } from './protocols';
import {
  AgentBudgetError,
  runAgentLoop,
  type AgentLoopRequest,
  type AgentLoopRuntime,
} from './agent';

const provider: ResolvedProvider = {
  definition: providerById('ollama')!,
  baseUrl: 'http://localhost:11434/v1',
  apiKey: null,
  model: 'qwen2.5',
};

function request(overrides: Partial<AgentLoopRequest> = {}): AgentLoopRequest {
  return {
    provider,
    instruction: 'Inspect the library and finish.',
    scope: { kind: 'library' },
    scopeContext: 'Empty library',
    plan: {
      summary: 'Inspect safely',
      steps: [{ description: 'Read app state', expectedTools: ['get_app_state'] }],
    },
    budget: {
      tokenCeiling: 1_000_000,
      toolCallCeiling: 4,
      wallClockMs: 10_000,
    },
    language: 'English',
    executeTool: vi.fn(async () => ({ ok: true as const, value: { ready: true } })),
    ...overrides,
  };
}

function runtime(decisions: AgentDecision[]): AgentLoopRuntime {
  let index = 0;
  return {
    decide: vi.fn(async () => decisions[index++]!),
    now: () => 0,
    newId: () => `call-${index}`,
  };
}

describe('in-app agent loop', () => {
  it('uses exactly the public MCP tool surface', () => {
    expect([...AGENT_TOOL_NAMES].sort()).toEqual(Object.keys(TOOL_HANDLERS).sort());
  });

  it('executes one visible tool at a time and stops on done', async () => {
    const events: string[] = [];
    const input = request({
      onToolStart: ({ decision }) => events.push(`start:${decision.tool}`),
      onToolFinish: ({ decision }) => events.push(`finish:${decision.tool}`),
    });
    const result = await runAgentLoop(
      input,
      {},
      runtime([
        {
          action: 'tool',
          tool: 'get_app_state',
          arguments: {},
          rationale: 'See the current context.',
        },
        { action: 'done', summary: 'The library was inspected.' },
      ]),
    );

    expect(input.executeTool).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['start:get_app_state', 'finish:get_app_state']);
    expect(result).toMatchObject({ summary: 'The library was inspected.', toolCalls: 1 });
  });

  it('enforces token and tool-call ceilings', async () => {
    await expect(
      runAgentLoop(
        request({ budget: { tokenCeiling: 1, toolCallCeiling: 1, wallClockMs: 10_000 } }),
        {},
        runtime([{ action: 'done', summary: 'Impossible' }]),
      ),
    ).rejects.toEqual(expect.objectContaining({ limit: 'tokens' }));

    await expect(
      runAgentLoop(
        request({
          budget: { tokenCeiling: 1_000_000, toolCallCeiling: 1, wallClockMs: 10_000 },
        }),
        {},
        runtime([
          { action: 'tool', tool: 'get_app_state', arguments: {}, rationale: 'First.' },
          { action: 'tool', tool: 'list_courses', arguments: {}, rationale: 'Second.' },
        ]),
      ),
    ).rejects.toEqual(expect.objectContaining({ limit: 'tools' }));
  });

  it('propagates cancellation into a tool that is already running', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = runAgentLoop(
      request({
        executeTool: async (_tool, _args, signal) => {
          entered();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { ok: false, code: 'cancelled', message: 'cancelled' };
        },
      }),
      { signal: controller.signal },
      runtime([
        { action: 'tool', tool: 'list_courses', arguments: {}, rationale: 'Inspect.' },
      ]),
    );

    await started;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops once wall-clock time is exhausted', async () => {
    let now = 0;
    const clock: AgentLoopRuntime = {
      decide: async () => ({
        action: 'tool',
        tool: 'get_app_state',
        arguments: {},
        rationale: 'Inspect.',
      }),
      now: () => now,
      newId: () => 'call-time',
    };
    const input = request({
      budget: { tokenCeiling: 1_000_000, toolCallCeiling: 4, wallClockMs: 100 },
      executeTool: async () => {
        now = 101;
        return { ok: true, value: {} };
      },
    });

    await expect(runAgentLoop(input, {}, clock)).rejects.toBeInstanceOf(AgentBudgetError);
  });
});
