/**
 * A native run, end to end through the real command layer: planning over the
 * JSON path, then decisions as Anthropic tool calls — a parallel pair of reads,
 * a question the student answers, a write, and `finish`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiTransport, library, secrets } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { secretKeyFor } from '@/lib/ai';
import { useAgentStore } from '@/lib/state/agentStore';
import { useAiStore } from '@/lib/state/aiStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import {
  answerAgentQuestionCommand,
  planAgentCommand,
  runAgentCommand,
} from './agentCommands';
import { createNoteCommand } from './noteCommands';
import { createCourseCommand } from './organizationCommands';

function anthropic(content: unknown[]) {
  return { status: 200, headers: {}, body: JSON.stringify({ content }) };
}

beforeEach(async () => {
  memoryLibraryAdapter.reset();
  localStorage.clear();
  useAgentStore.setState({ runs: [], activeRunId: null });
  await secrets.set(secretKeyFor('anthropic'), 'test-key');
  await useSettingsStore.getState().update({
    aiFeatureModels: { agent: { providerId: 'anthropic', model: 'claude-sonnet-5' } },
    agentInstructions: 'Course names are in English.',
  });
  await useAiStore.getState().refreshProviders();
});

afterEach(() => vi.restoreAllMocks());

describe('a native agent run', () => {
  it('reads in parallel, asks, writes, and records it all', async () => {
    const physics = await createCourseCommand({ name: 'Physics' });
    const maths = await createCourseCommand({ name: 'Maths' });
    const note = await createNoteCommand({ title: 'Lab safety' });
    if (!physics.ok || !maths.ok || !note.ok) throw new Error('fixture');
    const noteId = note.value.id;

    const bodies: string[] = [];
    const responses = [
      // Plan (JSON path).
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                summary: 'Move the note.',
                steps: [
                  {
                    description: 'Move it.',
                    expectedTools: ['organize'],
                    noteIds: [noteId],
                  },
                ],
              }),
            },
          ],
        }),
      },
      anthropic([
        {
          type: 'tool_use',
          id: 't1',
          name: 'read_note',
          input: { noteId, format: 'markdown', rationale: 'Reading the note.' },
        },
        {
          type: 'tool_use',
          id: 't2',
          name: 'list_courses',
          input: { rationale: 'Listing courses.' },
        },
      ]),
      anthropic([
        {
          type: 'tool_use',
          id: 't3',
          name: 'ask_student',
          input: { question: 'Which course?', options: ['Physics', 'Maths'] },
        },
      ]),
      'organize',
      anthropic([
        {
          type: 'tool_use',
          id: 't5',
          name: 'finish',
          input: { outcomeAchieved: true, summary: 'Moved to Physics.' },
        },
      ]),
    ];
    vi.spyOn(aiTransport, 'request').mockImplementation(async (request) => {
      bodies.push(String(request.body));
      const next = responses.shift();
      if (next === 'organize') {
        const current = await library.getNote(noteId);
        return anthropic([
          {
            type: 'tool_use',
            id: 't4',
            name: 'organize',
            input: {
              moves: [
                {
                  noteId,
                  baseUpdatedAt: current!.updatedAt,
                  courseId: physics.value.id,
                  sectionId: null,
                },
              ],
              rationale: 'Moving it into Physics.',
            },
          },
        ]);
      }
      return next as ReturnType<typeof anthropic>;
    });

    const planned = await planAgentCommand({
      instruction: 'Move Lab safety to its course.',
      scope: { kind: 'library' },
    });
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.value.standingInstructions).toBe('Course names are in English.');

    const unsubscribe = useAgentStore.subscribe((store) => {
      const waiting = store.runs.find((run) => run.pendingQuestion);
      if (waiting)
        queueMicrotask(() => answerAgentQuestionCommand(waiting.id, 'Physics'));
    });
    const result = await runAgentCommand(planned.value.id);
    unsubscribe();
    if (!result.ok) throw new Error(result.message);

    expect(result.value).toMatchObject({
      status: 'completed',
      toolMode: 'native',
      summary: 'Moved to Physics.',
      questions: [
        { question: 'Which course?', options: ['Physics', 'Maths'], answer: 'Physics' },
      ],
    });
    expect(result.value.pendingQuestion).toBeUndefined();
    expect(
      result.value.calls.map((call) => [call.tool, call.status, call.rationale]),
    ).toEqual([
      ['read_note', 'succeeded', 'Reading the note.'],
      ['list_courses', 'succeeded', 'Listing courses.'],
      ['organize', 'succeeded', 'Moving it into Physics.'],
    ]);
    expect((await library.getNote(noteId))?.courseId).toBe(physics.value.id);

    // Decisions went out with native tools and the standing instructions; the
    // plan did not.
    const decision = JSON.parse(bodies[1]!);
    expect(decision.tool_choice).toEqual({ type: 'any' });
    expect(decision.tools.map((tool: { name: string }) => tool.name)).toContain(
      'ask_student',
    );
    expect(decision.messages[0].content).toContain('Course names are in English.');
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty('tools');
    // The answer reached the model.
    expect(JSON.parse(bodies[3]!).messages[0].content).toContain('"answer":"Physics"');
  });

  it('refuses an answer when nothing is waiting', () => {
    expect(answerAgentQuestionCommand('no-run', 'Physics')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(answerAgentQuestionCommand('no-run', '  ')).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
  });
});
