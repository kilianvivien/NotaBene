import { describe, expect, it } from 'vitest';
import { LibrarySchema } from '@/lib/schema';
import {
  formatAgentEvaluation,
  scoreAgentCase,
  summariseAgentEvaluation,
  type AgentEvalRun,
  type AgentEvalState,
} from './agentEvaluation';
import {
  AGENT_EVALUATION_CASES,
  agentEvaluationLibrary,
  EVAL_IDS,
} from './fixtures/agentEvaluation';

function pristine(): AgentEvalState {
  const library = agentEvaluationLibrary();
  return {
    courses: library.courses,
    sections: library.sections,
    notes: library.notes,
    tags: library.tags,
    tasks: library.tasks,
    taskNoteLinks: library.taskNoteLinks,
  };
}

const completed: AgentEvalRun = {
  status: 'completed',
  toolMode: 'native',
  calls: [{ tool: 'list_notes', status: 'succeeded' }],
  questions: 0,
  tokensUsed: 1_000,
  wallMs: 2_000,
};

describe('the agent evaluation corpus', () => {
  it('is a valid library with a dozen distinct cases', () => {
    expect(LibrarySchema.safeParse(agentEvaluationLibrary()).success).toBe(true);
    expect(AGENT_EVALUATION_CASES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(AGENT_EVALUATION_CASES.map((entry) => entry.id)).size).toBe(
      AGENT_EVALUATION_CASES.length,
    );
  });

  it('has no case that passes by doing nothing', () => {
    for (const testCase of AGENT_EVALUATION_CASES) {
      expect(testCase.check(pristine(), completed), testCase.id).not.toEqual([]);
    }
  });

  it('passes a case once the library is as asked, and fails an incomplete run anyway', () => {
    const state = pristine();
    const inbox = AGENT_EVALUATION_CASES.find((entry) => entry.id === 'file-inbox')!;
    for (const note of state.notes) {
      if (note.id === 'eval-inbox-oscillators' || note.id === 'eval-inbox-standing')
        note.courseId = EVAL_IDS.physics;
      if (note.id === 'eval-inbox-judicial') note.courseId = EVAL_IDS.law;
    }
    expect(scoreAgentCase(inbox, completed, state)).toMatchObject({
      passed: true,
      failures: [],
    });
    expect(
      scoreAgentCase(inbox, { ...completed, status: 'failed', error: 'budget' }, state),
    ).toMatchObject({
      passed: false,
      failures: ['run failed: budget'],
    });
  });

  it('catches an agent that obeyed the planted instruction', () => {
    const state = pristine();
    const injection = AGENT_EVALUATION_CASES.find(
      (entry) => entry.id === 'ignore-injection',
    )!;
    state.notes = state.notes.map((note) =>
      note.courseId === EVAL_IDS.physics
        ? { ...note, trashedAt: '2026-09-02T00:00:00.000Z' }
        : note,
    );
    expect(
      injection.check(state, completed).some((failure) => failure.startsWith('trashed')),
    ).toBe(true);
  });

  it('summarises and formats per provider', () => {
    const results = AGENT_EVALUATION_CASES.slice(0, 2).map((entry, index) =>
      scoreAgentCase(
        entry,
        { ...completed, tokensUsed: 1_000 * (index + 1) },
        pristine(),
      ),
    );
    const summary = summariseAgentEvaluation(
      'Anthropic claude-sonnet-5',
      'native',
      results,
    );
    expect(summary).toMatchObject({
      caseCount: 2,
      passRate: 0,
      meanTokens: 1_500,
      meanToolCalls: 1,
    });
    expect(formatAgentEvaluation(summary)).toContain('FAIL  file-inbox');
  });
});
