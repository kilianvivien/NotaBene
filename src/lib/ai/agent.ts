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
  AgentPlanDraftSchema,
  type AgentBudget,
  type AgentDecision,
  type AgentPlan,
  type AgentPlanDraft,
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
- get_app_state {} — current note, view, selection, and the task open in the Tasks view
- list_courses {} — courses and sections
- list_tags {} — the library's existing tag taxonomy
- list_notes { courseId?, scope?: "live"|"archived"|"trashed", limit?, offset? } — note summaries; use the trashed scope before restoring
- search_notes { query, limit? } — app search syntax
- read_note { noteId, format?: "json"|"markdown"|"both" } — full note and updatedAt
- create_note { title?, courseId?, sectionId?, markdown?|doc?, tags? } — create a note
- update_note { noteId, baseUpdatedAt, title?, markdown?|doc?, courseId?, sectionId?, archived? } — versioned update; use trash_notes for recoverable removal
- merge_notes { notes: [{ noteId, baseUpdatedAt }], title?, sourceFate?: "keep"|"archive"|"trash" } — merge notes in the supplied order; Trash is recoverable and permanent deletion is unavailable
- trash_notes { notes: [{ noteId, baseUpdatedAt }] } — move notes to recoverable Trash; never permanently delete
- restore_notes { notes: [{ noteId, baseUpdatedAt }] } — restore notes from Trash
- manage_tags { noteId, baseUpdatedAt, add?, remove?, rename? } — versioned tag update
- create_course { name, professor?, semester? } — create a course; whole-library scope only
- export_notes { noteIds, format, fileName, layout?, includeToc? } — export into NotaBene's exports folder
- organize { createSection?: { courseId, name }, moves?: [{ noteId, baseUpdatedAt, courseId: string|null, sectionId: string|null }] } — create a section and/or move notes. Every move must include both courseId and sectionId; use null explicitly for no course or no section
- list_tasks { status?, courseId?, parentId?, noteId?, dueBefore?, scope?: "live"|"trashed"|"all", sort?, limit?, offset? } — assignments and to-dos; pass parentId: null for top-level tasks only
- create_task { title, details?, priority?, courseId?, parentId?, dueAt?, remindAt?, recurrence?: { freq: "daily"|"weekly"|"monthly", interval?, weekdays? }, noteIds? } — create a task; subtasks are one level deep and only a top-level task may repeat
- update_task { taskId, baseUpdatedAt, title?, details?, status?, priority?, courseId?, dueAt?, remindAt?, recurrence?, trashed? } — versioned update; trashed: true moves it to recoverable Trash and trashed: false restores it, and permanent deletion is unavailable
- complete_task { taskId, baseUpdatedAt, done? } — tick a task off; this is the only correct way to finish one, because it closes subtasks and rolls a repeating task forward to its next occurrence rather than closing it
- link_task_note { taskId, noteId, linked? } — attach a task to a note, or detach it with linked: false
`.trim();

export interface AgentPlanRequest {
  provider: ResolvedProvider;
  instruction: string;
  scope: AgentScope;
  scopeContext: string;
  followUpContext?: AgentFollowUpContext;
  language: string;
}

export interface AgentFollowUpContext {
  instruction: string;
  planSummary: string;
  resultSummary?: string;
  touchedNoteTitles: string[];
}

export async function requestAgentPlan(
  request: AgentPlanRequest,
  options: AiRunOptions = {},
): Promise<AgentPlanDraft> {
  return runStructured(
    {
      provider: request.provider,
      messages: [
        {
          role: 'system',
          content: `You plan safe, reviewable work inside NotaBene. Return JSON only. Do not execute anything. Use only the tools listed below and never invent a permanent-delete or empty-Trash operation. Every note-changing operation must first obtain the current updatedAt by reading, listing, or searching. Keep the plan concise and observable. Write the plan in ${request.language}. Plan summaries and step descriptions are shown directly to the student: use ordinary language only. Never mention internal field names (such as updatedAt, baseUpdatedAt, noteId, courseId or sectionId), JSON, schemas, tokens, tool calls, or MCP. Describe a safety read as checking the latest saved note before changing it. Refer to notes by title and never put an internal note id in visible strings. Put every note id needed by a step only in that step's noteIds array. If the instruction needs a wider scope, describe the honest required tools anyway; never substitute a different destination or weaker outcome. The app will ask the student to widen explicitly.\n\nTools:\n${AGENT_TOOL_GUIDE}`,
        },
        {
          role: 'user',
          content: `${followUpPrompt(request.followUpContext)}Instruction:\n${request.instruction}\n\nApproved scope:\n${JSON.stringify(request.scope)}\n\nScope contents:\n${request.scopeContext}\n\nReturn {"summary":"...","steps":[{"description":"...","expectedTools":["..."],"noteIds":["..."]}]}.`,
        },
      ],
      maxTokens: PLAN_MAX_TOKENS,
      temperature: 0.2,
    },
    AgentPlanDraftSchema,
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
  followUpContext?: AgentFollowUpContext;
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
  outcomeAchieved: boolean;
  toolCalls: number;
  tokensUsed: number;
}

export class AgentBudgetError extends Error {
  constructor(readonly limit: 'tokens' | 'tools' | 'time') {
    super(`agent ${limit} budget exhausted`);
    this.name = 'AgentBudgetError';
  }
}

/** A scope refusal is a policy boundary, not feedback the model may work
 * around by choosing a different destination. */
export class AgentScopeError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentScopeError';
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
        return {
          summary: decision.summary,
          outcomeAchieved: decision.outcomeAchieved,
          toolCalls,
          tokensUsed,
        };
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
      if (!outcome.ok && outcome.code === 'scope_denied') {
        throw new AgentScopeError(outcome.message, outcome.details);
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
          content: `You are the in-app NotaBene agent. Work through the approved plan one tool call at a time. Use only the exact MCP tools below. Respect the approved scope; the executor will reject anything outside it. Never permanently delete or empty Trash. Before every note-changing operation, obtain the note's current updatedAt. After a conflict, read again before retrying. Rationale and summary strings are shown directly to the student: use ordinary language only and never mention internal field names (such as updatedAt, baseUpdatedAt, noteId, courseId or sectionId), JSON, schemas, tokens, tool calls, or MCP. Describe a safety read as checking the latest saved note before changing it. Before returning done, compare the actual successful tool outcomes with the original instruction and approved plan. Set outcomeAchieved true only when the requested outcome—not a fallback or weaker substitute—was achieved; otherwise set it false and explain what remains. Return a concise summary in ${request.language} and one JSON object only.\n\nTools:\n${AGENT_TOOL_GUIDE}`,
        },
        {
          role: 'user',
          content: `${followUpPrompt(request.followUpContext)}Instruction:\n${request.instruction}\n\nApproved plan:\n${JSON.stringify(request.plan)}\n\nApproved scope:\n${JSON.stringify(request.scope)}\n\nScope contents:\n${request.scopeContext}\n\nCalls so far:\n${JSON.stringify(transcript)}\n\nReturn either {"action":"tool","tool":"...","arguments":{},"rationale":"..."} or {"action":"done","outcomeAchieved":true|false,"summary":"..."}.`,
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
    `${JSON.stringify(request.followUpContext)}\n${request.instruction}\n${request.scopeContext}\n${JSON.stringify(request.plan)}\n${JSON.stringify(transcript)}\n${AGENT_TOOL_GUIDE}`,
  );
}

function followUpPrompt(context: AgentFollowUpContext | undefined): string {
  if (!context) return '';
  return `This is a follow-up to the previous task. Treat the new instruction as a refinement or continuation unless it clearly asks for something unrelated.\nPrevious task:\n${JSON.stringify(context)}\n\n`;
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
