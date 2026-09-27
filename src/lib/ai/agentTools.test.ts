import { describe, expect, it, vi } from 'vitest';
import { AGENT_TOOL_NAMES, type AgentDecision } from '@/lib/schema';
import { agentToolParameters } from '@/lib/mcp/toolHandlers';
import { providerById } from './providers';
import {
  buildRequest,
  geminiSchema,
  parseToolResponse,
  type ResolvedProvider,
} from './protocols';
import {
  agentToolDefinitions,
  agentToolDescriptions,
  requestNativeDecision,
  runAgentLoop,
  toolResponseDecision,
  usesNativeTools,
  type AgentLoopRequest,
  type AgentLoopRuntime,
} from './agent';

function resolved(id: string, model = 'm'): ResolvedProvider {
  const definition = providerById(id)!;
  return {
    definition,
    baseUrl: definition.defaultBaseUrl || 'http://x',
    apiKey: 'k',
    model,
  };
}

const definitions = agentToolDefinitions(agentToolParameters());

function request(overrides: Partial<AgentLoopRequest> = {}): AgentLoopRequest {
  return {
    provider: resolved('anthropic'),
    instruction: 'Tag the midterm notes.',
    scope: { kind: 'library' },
    scopeContext: 'Library',
    plan: {
      summary: 'Tag',
      noteReferences: [],
      steps: [{ description: 'Look', expectedTools: ['list_notes'], noteIds: [] }],
    },
    budget: { tokenCeiling: 1_000_000, toolCallCeiling: 10, wallClockMs: 1_000 },
    language: 'English',
    toolDefinitions: definitions,
    executeTool: vi.fn(async () => ({ ok: true as const, value: [] })),
    ...overrides,
  };
}

function runtime(decisions: AgentDecision[], clock = { now: 0 }): AgentLoopRuntime {
  let index = 0;
  return {
    decide: vi.fn(async () => decisions[index++]!),
    now: () => clock.now,
    newId: () => `call-${index}-${Math.random()}`,
  };
}

describe('generated tool definitions', () => {
  it('describes every MCP tool from its handler schema, plus finish and ask', () => {
    expect(definitions.map((tool) => tool.name)).toEqual([
      ...AGENT_TOOL_NAMES,
      'finish',
      'ask_student',
    ]);
    const descriptions = agentToolDescriptions();
    expect(Object.keys(descriptions).sort()).toEqual([...AGENT_TOOL_NAMES].sort());

    const update = definitions.find((tool) => tool.name === 'update_note')!
      .parameters as {
      required: string[];
      properties: Record<string, { anyOf?: unknown[] }>;
    };
    expect(update.required).toEqual(['noteId', 'baseUpdatedAt', 'rationale']);
    expect(update.properties.courseId?.anyOf).toEqual([
      { type: 'string' },
      { type: 'null' },
    ]);
  });

  it('only turns native calling on where the provider declares it', () => {
    expect(
      usesNativeTools({ provider: resolved('anthropic'), toolDefinitions: definitions }),
    ).toBe(true);
    expect(
      usesNativeTools({ provider: resolved('ollama'), toolDefinitions: definitions }),
    ).toBe(false);
    expect(
      usesNativeTools({ provider: resolved('anthropic'), toolDefinitions: [] }),
    ).toBe(false);
  });
});

describe('native tool calls on the wire', () => {
  const tools = { definitions: definitions.slice(0, 2), required: true };
  const call = (id: string) => ({
    provider: resolved(id),
    messages: [{ role: 'user' as const, content: 'hi' }],
    maxTokens: 10,
    temperature: 0,
    json: true,
    stream: false,
    tools,
  });

  it('forces a call in each protocol’s own words, and drops JSON mode', () => {
    const anthropic = JSON.parse(buildRequest(call('anthropic')).body!);
    expect(anthropic.tool_choice).toEqual({ type: 'any' });
    expect(anthropic.tools[0]).toHaveProperty('input_schema');
    const openai = JSON.parse(buildRequest(call('openai')).body!);
    expect(openai.tool_choice).toBe('required');
    expect(openai).not.toHaveProperty('response_format');
    expect(JSON.parse(buildRequest(call('mistral')).body!).tool_choice).toBe('any');
    const gemini = JSON.parse(buildRequest(call('gemini')).body!);
    expect(gemini.toolConfig.functionCallingConfig.mode).toBe('ANY');
    expect(gemini.generationConfig).not.toHaveProperty('responseMimeType');
  });

  it('reads calls back from each protocol', () => {
    expect(
      parseToolResponse(
        resolved('anthropic'),
        JSON.stringify({
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: 'a1', name: 'list_tags', input: { rationale: 'r' } },
          ],
        }),
      ),
    ).toEqual({
      text: 'Looking.',
      calls: [{ id: 'a1', name: 'list_tags', arguments: { rationale: 'r' } }],
    });
    expect(
      parseToolResponse(
        resolved('openai'),
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'o1',
                    function: { name: 'read_note', arguments: '{"noteId":"n1"}' },
                  },
                  { id: 'o2', function: { name: 'read_note', arguments: 'not json' } },
                ],
              },
            },
          ],
        }),
      ).calls,
    ).toEqual([
      { id: 'o1', name: 'read_note', arguments: { noteId: 'n1' } },
      { id: 'o2', name: 'read_note', arguments: {} },
    ]);
    expect(
      parseToolResponse(
        resolved('gemini'),
        JSON.stringify({
          candidates: [
            { content: { parts: [{ functionCall: { name: 'list_tags', args: {} } }] } },
          ],
        }),
      ).calls,
    ).toEqual([{ id: 'call_0', name: 'list_tags', arguments: {} }]);
  });

  it('rewrites a schema into the subset Gemini accepts', () => {
    expect(
      geminiSchema({
        type: 'object',
        additionalProperties: false,
        properties: {
          courseId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          doc: { type: 'object' },
          mode: { const: 'x', default: 'x' },
        },
        required: ['courseId', 'doc'],
      }),
    ).toEqual({
      type: 'object',
      properties: { courseId: { type: 'string', nullable: true }, mode: { enum: ['x'] } },
      required: ['courseId'],
    });
  });
});

describe('native decisions', () => {
  it('turns calls into a batch, prefers work over a premature finish, and strips the rationale', () => {
    const decision = toolResponseDecision({
      text: '',
      calls: [
        {
          id: '1',
          name: 'read_note',
          arguments: { noteId: 'a', rationale: 'Reading A' },
        },
        { id: '2', name: 'read_note', arguments: { noteId: 'b' } },
        {
          id: '3',
          name: 'finish',
          arguments: { outcomeAchieved: true, summary: 'Done' },
        },
        { id: '4', name: 'empty_trash', arguments: {} },
      ],
    });
    expect(decision).toEqual({
      action: 'batch',
      calls: [
        { tool: 'read_note', arguments: { noteId: 'a' }, rationale: 'Reading A' },
        { tool: 'read_note', arguments: { noteId: 'b' }, rationale: 'read note' },
      ],
    });
    expect(
      toolResponseDecision({
        text: '',
        calls: [
          {
            id: '1',
            name: 'ask_student',
            arguments: { question: 'Which course?', options: ['A', 'B'] },
          },
        ],
      }),
    ).toEqual({ action: 'ask', question: 'Which course?', options: ['A', 'B'] });
    expect(toolResponseDecision({ text: 'I think…', calls: [] })).toBeNull();
  });

  it('nudges once when the model answers in prose, and carries standing instructions', async () => {
    const { aiTransport } = await import('@/lib/adapters');
    const bodies = [
      { content: [{ type: 'text', text: 'Let me think.' }] },
      {
        content: [
          {
            type: 'tool_use',
            id: 'x',
            name: 'finish',
            input: { outcomeAchieved: true, summary: 'ok' },
          },
        ],
      },
    ];
    const spy = vi
      .spyOn(aiTransport, 'request')
      .mockImplementation(async () => ({
        status: 200,
        headers: {},
        body: JSON.stringify(bodies.shift()),
      }));
    const decision = await requestNativeDecision(
      request({ standingInstructions: 'Tags are in French.' }),
      [],
      {},
    );
    expect(decision).toEqual({ action: 'done', outcomeAchieved: true, summary: 'ok' });
    expect(spy).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String(spy.mock.calls[1]?.[0].body));
    expect(second.messages[0].content).toContain('Tags are in French.');
    expect(second.messages[0].content).toContain('Answer with a tool call');
    spy.mockRestore();
  });
});

describe('the loop with batches and questions', () => {
  it('runs independent reads side by side, and writes one after another', async () => {
    let concurrent = 0;
    let peak = 0;
    const executeTool = vi.fn(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return { ok: true as const, value: {} };
    });
    const read = (noteId: string) => ({
      tool: 'read_note' as const,
      arguments: { noteId },
      rationale: 'r',
    });
    const write = (noteId: string) => ({
      tool: 'archive_notes' as const,
      arguments: { noteId },
      rationale: 'w',
    });

    await runAgentLoop(
      request({ executeTool }),
      {},
      runtime([
        { action: 'batch', calls: [read('a'), read('b'), read('c')] },
        { action: 'done', outcomeAchieved: true, summary: 'ok' },
      ]),
    );
    expect(peak).toBe(3);

    peak = 0;
    await runAgentLoop(
      request({ executeTool }),
      {},
      runtime([
        { action: 'batch', calls: [read('a'), write('a'), write('b')] },
        { action: 'done', outcomeAchieved: true, summary: 'ok' },
      ]),
    );
    expect(peak).toBe(1);
  });

  it('stops a batch at a scope refusal rather than running the writes after it', async () => {
    const executeTool = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'scope_denied', message: 'no' })
      .mockResolvedValue({ ok: true, value: {} });
    await expect(
      runAgentLoop(
        request({ executeTool }),
        {},
        runtime([
          {
            action: 'batch',
            calls: [
              { tool: 'archive_notes', arguments: {}, rationale: 'w' },
              { tool: 'archive_notes', arguments: {}, rationale: 'w' },
            ],
          },
        ]),
      ),
    ).rejects.toThrow('no');
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('asks the student, pauses the wall clock while waiting, and caps the questions', async () => {
    const clock = { now: 0 };
    const askStudent = vi.fn(async () => {
      // Longer than the whole run's allowance: the wait must not count.
      clock.now += 5_000;
      return 'Physics';
    });
    const decide = runtime(
      [
        { action: 'ask', question: 'Which course?', options: ['Physics', 'Maths'] },
        { action: 'ask', question: 'Archive or trash?', options: [] },
        { action: 'ask', question: 'A third?', options: [] },
        { action: 'done', outcomeAchieved: true, summary: 'ok' },
      ],
      clock,
    );
    const result = await runAgentLoop(request({ askStudent }), {}, decide);
    expect(result.questions).toBe(2);
    expect(askStudent).toHaveBeenCalledTimes(2);
    const lastTranscript = (decide.decide as ReturnType<typeof vi.fn>).mock
      .calls[3]![1] as unknown[];
    expect(lastTranscript[0]).toEqual({ question: 'Which course?', answer: 'Physics' });
    expect(lastTranscript[2]).toMatchObject({ question: 'A third?', answer: null });
  });

  it('tells the model it cannot ask when the surface has no way to', async () => {
    const decide = runtime([
      { action: 'ask', question: 'Which?', options: [] },
      { action: 'done', outcomeAchieved: false, summary: 'needed an answer' },
    ]);
    const result = await runAgentLoop(request(), {}, decide);
    expect(result.questions).toBe(0);
    expect(result.outcomeAchieved).toBe(false);
  });
});
