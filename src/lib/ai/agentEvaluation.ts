/**
 * How good the agent is, as numbers rather than an impression (plan §3.2,
 * item 1).
 *
 * The same discipline as `retrievalEvaluation.ts`: the scorer knows nothing
 * about providers or prompts. It takes a case, the library as the run left it,
 * and the run's own journal, and says whether the instruction was carried out
 * — so a change to the loop is judged against the same checks before and
 * after. The corpus lives in `fixtures/agentEvaluation.ts`; the hand-run
 * harness that drives real providers is `agentEvaluation.live.test.ts`.
 */
import type {
  AgentRunRecord,
  Course,
  Note,
  Section,
  Tag,
  Task,
  TaskNoteLink,
} from '@/lib/schema';

/** The library after a run, as a check reads it. */
export interface AgentEvalState {
  courses: Course[];
  sections: Section[];
  notes: Note[];
  tags: Tag[];
  tasks: Task[];
  taskNoteLinks: TaskNoteLink[];
}

export interface AgentEvalCase {
  id: string;
  /** Exactly what a student would type. */
  instruction: string;
  /** `library`, or the id of the course the run is scoped to. */
  scope: { kind: 'library' } | { kind: 'course'; courseId: string };
  /** Answers the harness gives, in order, if the agent asks. */
  answers?: string[];
  /**
   * What must be true afterwards. Returns the reasons it is not — empty means
   * the case passed. Written against ids and text, never against which tools
   * were used: two correct routes to the same library are both correct.
   */
  check(state: AgentEvalState, run: AgentEvalRun): string[];
}

/** What the scorer needs from a run: its journal, and how long it took. */
export interface AgentEvalRun {
  status: AgentRunRecord['status'];
  toolMode?: AgentRunRecord['toolMode'];
  calls: Pick<AgentRunRecord['calls'][number], 'tool' | 'status'>[];
  questions: number;
  tokensUsed: number;
  wallMs: number;
  error?: string;
}

export interface AgentCaseResult {
  caseId: string;
  passed: boolean;
  failures: string[];
  toolCalls: number;
  failedCalls: number;
  questions: number;
  tokensUsed: number;
  wallMs: number;
}

export interface AgentEvaluationSummary {
  label: string;
  toolMode: string;
  caseCount: number;
  passRate: number;
  meanToolCalls: number;
  meanTokens: number;
  meanWallMs: number;
  cases: AgentCaseResult[];
}

export function scoreAgentCase(
  testCase: AgentEvalCase,
  run: AgentEvalRun,
  state: AgentEvalState,
): AgentCaseResult {
  const failures: string[] = [];
  // A run that did not complete has not carried out the instruction, whatever
  // the library happens to look like — a half-finished merge can pass a check
  // by accident.
  if (run.status !== 'completed')
    failures.push(`run ${run.status}${run.error ? `: ${run.error}` : ''}`);
  failures.push(...testCase.check(state, run));
  return {
    caseId: testCase.id,
    passed: failures.length === 0,
    failures,
    toolCalls: run.calls.length,
    failedCalls: run.calls.filter((call) => call.status === 'failed').length,
    questions: run.questions,
    tokensUsed: run.tokensUsed,
    wallMs: run.wallMs,
  };
}

export function summariseAgentEvaluation(
  label: string,
  toolMode: string,
  results: AgentCaseResult[],
): AgentEvaluationSummary {
  const mean = (pick: (result: AgentCaseResult) => number) =>
    results.length
      ? results.reduce((total, result) => total + pick(result), 0) / results.length
      : 0;
  return {
    label,
    toolMode,
    caseCount: results.length,
    passRate: results.length
      ? results.filter((result) => result.passed).length / results.length
      : 0,
    meanToolCalls: mean((result) => result.toolCalls),
    meanTokens: mean((result) => result.tokensUsed),
    meanWallMs: mean((result) => result.wallMs),
    cases: results,
  };
}

/** A fixed-width table for the terminal, one row per case and a total. */
export function formatAgentEvaluation(summary: AgentEvaluationSummary): string {
  const rows = summary.cases.map(
    (result) =>
      `${result.passed ? 'PASS' : 'FAIL'}  ${result.caseId.padEnd(22)} ${String(result.toolCalls).padStart(3)} calls ${String(result.tokensUsed).padStart(8)} tok ${(result.wallMs / 1000).toFixed(1).padStart(6)} s${result.failures.length ? `  — ${result.failures.join('; ')}` : ''}`,
  );
  return [
    `${summary.label} (${summary.toolMode}): ${(summary.passRate * 100).toFixed(0)}% of ${summary.caseCount}, ${summary.meanToolCalls.toFixed(1)} calls, ${Math.round(summary.meanTokens)} tokens, ${(summary.meanWallMs / 1000).toFixed(1)} s on average`,
    ...rows,
  ].join('\n');
}
