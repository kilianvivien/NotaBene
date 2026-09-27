/**
 * The agent evaluation, against a real provider. Skipped unless asked for.
 *
 * It drives the real command layer — planning, the review-free run, scope
 * enforcement, the MCP handlers, the in-memory library — exactly as the panel
 * would, answers the agent's questions from each case, and scores the library
 * afterwards. Run it by hand, like the rest of plan §16, with a real key:
 *
 *   NOTABENE_AGENT_EVAL=anthropic NOTABENE_AGENT_EVAL_KEY=sk-… pnpm eval:agent
 *
 * Optional: NOTABENE_AGENT_EVAL_MODEL, NOTABENE_AGENT_EVAL_BASE_URL (a local
 * runtime), NOTABENE_AGENT_EVAL_MODE=json (the JSON decision document even
 * where native calls exist, to compare the two), NOTABENE_AGENT_EVAL_CASES
 * (comma-separated ids). Results are printed and written to `agent-eval/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { library, secrets } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import {
  answerAgentQuestionCommand,
  planAgentCommand,
  runAgentCommand,
} from '@/lib/commands/agentCommands';
import { useAgentStore } from '@/lib/state/agentStore';
import { useAiStore } from '@/lib/state/aiStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import {
  formatAgentEvaluation,
  scoreAgentCase,
  summariseAgentEvaluation,
  type AgentCaseResult,
  type AgentEvalCase,
  type AgentEvalState,
} from './agentEvaluation';
import {
  AGENT_EVALUATION_CASES,
  agentEvaluationLibrary,
} from './fixtures/agentEvaluation';
import { providerById, secretKeyFor } from './providers';

const providerId = process.env.NOTABENE_AGENT_EVAL;
const forceJson = process.env.NOTABENE_AGENT_EVAL_MODE === 'json';
const only = process.env.NOTABENE_AGENT_EVAL_CASES?.split(',').map((id) => id.trim());
const cases = AGENT_EVALUATION_CASES.filter((entry) => !only || only.includes(entry.id));
const results: AgentCaseResult[] = [];

async function configure(): Promise<string> {
  const definition = providerById(providerId ?? '');
  if (!definition) throw new Error(`unknown provider ${providerId}`);
  const model =
    process.env.NOTABENE_AGENT_EVAL_MODEL ??
    definition.featureDefaults?.agent ??
    definition.defaultModel;
  const key = process.env.NOTABENE_AGENT_EVAL_KEY;
  if (definition.requiresKey) {
    if (!key) throw new Error('NOTABENE_AGENT_EVAL_KEY is required for this provider');
    await secrets.set(secretKeyFor(definition.id), key);
  }
  await useSettingsStore.getState().update({
    aiFeatureModels: { agent: { providerId: definition.id, model } },
    aiProviders: {
      [definition.id]: {
        enabled: true,
        baseUrl: process.env.NOTABENE_AGENT_EVAL_BASE_URL ?? null,
        extraModels: [model],
      },
    },
  });
  await useAiStore.getState().refreshProviders();
  return `${definition.label} ${model}`;
}

async function state(): Promise<AgentEvalState> {
  const courses = await library.listCourses();
  const sections = (
    await Promise.all(courses.map((course) => library.listSections(course.id)))
  ).flat();
  const summaries = await library.queryNotes({ scope: 'all', limit: 10_000 });
  const notes = (
    await Promise.all(summaries.map((summary) => library.getNote(summary.id)))
  ).filter((note) => note !== null);
  return {
    courses,
    sections,
    notes,
    tags: await library.listTags(),
    tasks: await library.listTasks({ scope: 'all' }),
    taskNoteLinks: await library.listTaskNoteLinks(),
  };
}

async function runCase(testCase: AgentEvalCase): Promise<AgentCaseResult> {
  memoryLibraryAdapter.reset();
  await library.importLibrary(agentEvaluationLibrary(), 'replace');

  // Answer whatever the agent asks, from the case, as a student at the panel
  // would. A case without answers still gets one, so a question cannot hang.
  const answers = [...(testCase.answers ?? [])];
  const unsubscribe = useAgentStore.subscribe((store) => {
    const waiting = store.runs.find((run) => run.pendingQuestion);
    if (!waiting?.pendingQuestion) return;
    const answer =
      answers.shift() ?? waiting.pendingQuestion.options[0] ?? 'Use your best judgement.';
    queueMicrotask(() => answerAgentQuestionCommand(waiting.id, answer));
  });

  const started = Date.now();
  try {
    const planned = await planAgentCommand({
      instruction: testCase.instruction,
      scope: testCase.scope,
    });
    if (!planned.ok) {
      return scoreAgentCase(
        testCase,
        {
          status: 'failed',
          calls: [],
          questions: 0,
          tokensUsed: 0,
          wallMs: Date.now() - started,
          error: `plan: ${planned.message}`,
        },
        await state(),
      );
    }
    await runAgentCommand(planned.value.id, {}, { forceJson });
    const run = useAgentStore
      .getState()
      .runs.find((entry) => entry.id === planned.value.id)!;
    return scoreAgentCase(
      testCase,
      {
        status: run.status,
        toolMode: run.toolMode,
        calls: run.calls,
        questions: run.questions?.length ?? 0,
        tokensUsed: run.tokensUsed,
        wallMs: Date.now() - started,
        error: run.error,
      },
      await state(),
    );
  } finally {
    unsubscribe();
  }
}

describe.skipIf(!providerId)('agent evaluation against a live provider', () => {
  let label = '';

  it('configures the provider', async () => {
    label = await configure();
    expect(label).toBeTruthy();
  });

  for (const testCase of cases) {
    it(
      testCase.id,
      async () => {
        results.push(await runCase(testCase));
      },
      15 * 60_000,
    );
  }

  afterAll(() => {
    if (!results.length) return;
    const summary = summariseAgentEvaluation(
      label,
      forceJson ? 'json' : 'native where supported',
      results,
    );
    process.stdout.write(`\n${formatAgentEvaluation(summary)}\n\n`);
    const directory = resolve(__dirname, '../../../agent-eval');
    mkdirSync(directory, { recursive: true });
    const file = `${label.replace(/[^\w.-]+/g, '-')}-${forceJson ? 'json' : 'native'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(resolve(directory, file), JSON.stringify(summary, null, 2));
  });
});
