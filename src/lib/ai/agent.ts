/**
 * The in-app agent loop.
 *
 * It deliberately speaks in MCP tool calls rather than importing commands:
 * the executor supplied by `agentCommands.ts` invokes the exact same handlers
 * as the loopback server. This file owns model turns, budgets and cancellation;
 * the command layer owns scope enforcement, journaling and writes.
 */
import {
  AgentDecisionSchema,
  AgentPlanSchema,
  type AgentBudget,
  type AgentDecision,
  type AgentPlan,
  type AgentScope,
  type AgentToolName,
} from '@/lib/schema';
import { estimateTokens, type AiRunOptions } from './client';
import type { ResolvedProvider } from './protocols';
import { runStructured } from './structured';

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  tokenCeiling: 50_000,
  toolCallCeiling: 24,
  wallClockMs: 120_000,
};

const DECISION_MAX_TOKENS = 1_200;
const PLAN_MAX_TOKENS = 1_600;
const MAX_TOOL_RESULT_CHARS = 16_000;

export const AGENT_TOOL_GUIDE = `
- get_app_state {} — current note, view and selection
- list_courses {} — courses and sections
- list_notes { courseId?, limit?, offset? } — note summaries
- search_notes { query, limit? } — app search syntax
- read_note { noteId, format?: "json"|"markdown"|"both" } — full note and updatedAt
- create_note { title?, courseId?, sectionId?, markdown?|doc?, tags? } — create a note
- update_note { noteId, baseUpdatedAt, title?, markdown?|doc?, courseId?, sectionId?, archived? } — versioned update; archive, never delete
- manage_tags { noteId, baseUpdatedAt, add?, remove?, rename? } — versioned tag update
- create_course { name, professor?, semester? } — create a course
- export_notes { noteIds, format, fileName, layout?, includeToc? } — export into NotaBene's exports folder
- organize { createSection?, moves? } — create a section and/or move notes, with baseUpdatedAt per move
`.trim();

export interface AgentPlanRequest {
  provider: ResolvedProvider;
  instruction: string;
  scope: AgentScope;
  scopeContext: string;
  language: string;
}

export async function requestAgentPlan(
  request: AgentPlanRequest,
  options: AiRunOptions = {},
): Promise<AgentPlan> {
  return runStructured(
    {
      provider: request.provider,
      messages: [
        {
          role: 'system',
          content: `You plan safe, reviewable work inside NotaBene. Return JSON only. Do not execute anything. Use only the tools listed below and never invent a delete operation. Every update must first obtain the current updatedAt by reading, listing, or searching. Keep the plan concise and observable. Write the plan in ${request.language}.\n\nTools:\n${AGENT_TOOL_GUIDE}`,
        },
        {
          role: 'user',
          content: `Instruction:\n${request.instruction}\n\nApproved scope:\n${JSON.stringify(request.scope)}\n\nScope contents:\n${request.scopeContext}\n\nReturn {"summary":"...","steps":[{"description":"...","expectedTools":["..."]}]}.`,
        },
      ],
      maxTokens: PLAN_MAX_TOKENS,
      temperature: 0.2,
    },
    AgentPlanSchema,
    options,
  );
}

export type AgentToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string; details?: unknown };

export type AgentToolExecutor = (
  tool: AgentToolName,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<AgentToolOutcome>;

export interface AgentLoopEvent {
  callId: string;
  decision: Extract<AgentDecision, { action: 'tool' }>;
  outcome?: AgentToolOutcome;
}

export interface AgentLoopRequest {
  provider: ResolvedProvider;
  instruction: string;
  scope: AgentScope;
  scopeContext: string;
  plan: AgentPlan;
  budget: AgentBudget;
  language: string;
  executeTool: AgentToolExecutor;
  onToolStart?(event: AgentLoopEvent): void;
  onToolFinish?(event: AgentLoopEvent): void;
  onUsage?(usage: { tokensUsed: number; toolCalls: number }): void;
}

export interface AgentLoopResult {
  summary: string;
  toolCalls: number;
  tokensUsed: number;
}

export class AgentBudgetError extends Error {
  constructor(readonly limit: 'tokens' | 'tools' | 'time') {
    super(`agent ${limit} budget exhausted`);
    this.name = 'AgentBudgetError';
  }
}

export interface AgentLoopRuntime {
  decide(
    request: AgentLoopRequest,
    transcript: readonly unknown[],
    options: AiRunOptions,
  ): Promise<AgentDecision>;
  now(): number;
  newId(): string;
}

const defaultRuntime: AgentLoopRuntime = {
  decide: requestDecision,
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};

export async function runAgentLoop(
  request: AgentLoopRequest,
  options: AiRunOptions = {},
  runtime: AgentLoopRuntime = defaultRuntime,
): Promise<AgentLoopResult> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const deadline = runtime.now() + request.budget.wallClockMs;
  const wallTimer = setTimeout(
    () => controller.abort(new AgentBudgetError('time')),
    request.budget.wallClockMs,
  );
  const transcript: unknown[] = [];
  let toolCalls = 0;
  let tokensUsed = 0;

  try {
    while (true) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      if (runtime.now() >= deadline) throw new AgentBudgetError('time');

      const inputTokens = decisionInputTokens(request, transcript);
      if (tokensUsed + inputTokens + DECISION_MAX_TOKENS > request.budget.tokenCeiling) {
        throw new AgentBudgetError('tokens');
      }
      const decision = await runtime.decide(request, transcript, {
        ...options,
        signal: controller.signal,
        timeoutMs: Math.max(1, deadline - runtime.now()),
      });
      tokensUsed += inputTokens + estimateTokens(JSON.stringify(decision));
      request.onUsage?.({ tokensUsed, toolCalls });

      if (decision.action === 'done') {
        return { summary: decision.summary, toolCalls, tokensUsed };
      }
      if (toolCalls >= request.budget.toolCallCeiling) {
        throw new AgentBudgetError('tools');
      }

      toolCalls += 1;
      request.onUsage?.({ tokensUsed, toolCalls });
      const callId = runtime.newId();
      const event = { callId, decision };
      request.onToolStart?.(event);
      const outcome = await request.executeTool(
        decision.tool,
        decision.arguments,
        controller.signal,
      );
      request.onToolFinish?.({ ...event, outcome });
      transcript.push({
        tool: decision.tool,
        arguments: decision.arguments,
        rationale: decision.rationale,
        outcome: compactOutcome(outcome),
      });
      if (!outcome.ok && outcome.code === 'cancelled') {
        throw abortReason(controller.signal);
      }
    }
  } finally {
    clearTimeout(wallTimer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

async function requestDecision(
  request: AgentLoopRequest,
  transcript: readonly unknown[],
  options: AiRunOptions,
): Promise<AgentDecision> {
  return runStructured(
    {
      provider: request.provider,
      messages: [
        {
          role: 'system',
          content: `You are the in-app NotaBene agent. Work through the approved plan one tool call at a time. Use only the exact MCP tools below. Respect the approved scope; the executor will reject anything outside it. Never delete. Before every update, tag change, or move, obtain the note's current updatedAt. After a conflict, read again before retrying. When the instruction is satisfied, return done with a concise summary in ${request.language}. Return one JSON object only.\n\nTools:\n${AGENT_TOOL_GUIDE}`,
        },
        {
          role: 'user',
          content: `Instruction:\n${request.instruction}\n\nApproved plan:\n${JSON.stringify(request.plan)}\n\nApproved scope:\n${JSON.stringify(request.scope)}\n\nScope contents:\n${request.scopeContext}\n\nCalls so far:\n${JSON.stringify(transcript)}\n\nReturn either {"action":"tool","tool":"...","arguments":{},"rationale":"..."} or {"action":"done","summary":"..."}.`,
        },
      ],
      maxTokens: DECISION_MAX_TOKENS,
      temperature: 0,
    },
    AgentDecisionSchema,
    options,
  );
}

function decisionInputTokens(
  request: AgentLoopRequest,
  transcript: readonly unknown[],
): number {
  return estimateTokens(
    `${request.instruction}\n${request.scopeContext}\n${JSON.stringify(request.plan)}\n${JSON.stringify(transcript)}\n${AGENT_TOOL_GUIDE}`,
  );
}

function compactOutcome(outcome: AgentToolOutcome): unknown {
  const json = JSON.stringify(outcome);
  if (json.length <= MAX_TOOL_RESULT_CHARS) return outcome;
  return {
    ok: outcome.ok,
    truncated: true,
    preview: json.slice(0, MAX_TOOL_RESULT_CHARS),
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('cancelled', 'AbortError');
}
