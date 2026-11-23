import { describe, expect, it, vi } from 'vitest';
import { ImageDrawingPlanSchema } from '@/lib/schema';
import { aiTransport } from '@/lib/adapters';
import { elementCounter, imageDrawingPrompt, requestImageDrawing } from './imageDrawing';
import { preflight } from './client';
import { providerById } from './providers';
import { resolveFeature } from './resolve';
import { DEFAULT_SETTINGS } from '@/lib/adapters/settings/SettingsAdapter';

vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: (elements: unknown[]) => elements,
  exportToSvg: async () => ({ outerHTML: '<svg />' }),
}));

const rectangle = { type: 'rectangle', x: 0, y: 0, width: 100, height: 100 };
describe('image drawing contract', () => {
  it.each([
    [],
    [{ type: 'image', fileId: 'raster', x: 0, y: 0 }],
    [{ ...rectangle, width: Infinity }],
    [{ ...rectangle, x: 4001 }],
    [{ type: 'text', x: 0, y: 0, text: '' }],
    [
      {
        type: 'arrow',
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [0, 0],
        ],
      },
    ],
    [{ ...rectangle, backgroundColor: 'url(https://example.com)' }],
    Array.from({ length: 201 }, () => rectangle),
  ])('refuses empty, non-editable or unbounded scenes', (...elements) => {
    expect(ImageDrawingPlanSchema.safeParse({ title: 'Chart', elements }).success).toBe(
      false,
    );
  });
  it('retains original labels, coordinates and colours in a matrix', () => {
    const plan = ImageDrawingPlanSchema.parse({
      title: 'Délégation',
      elements: [
        { ...rectangle, backgroundColor: '#ccccff' },
        { type: 'text', x: 12, y: 20, text: 'Consignes\npas de délégation' },
        {
          type: 'arrow',
          x: 0,
          y: 100,
          points: [
            [0, 0],
            [200, 0],
          ],
        },
      ],
    });
    expect(plan.elements[1]).toMatchObject({
      text: 'Consignes\npas de délégation',
      x: 12,
      y: 20,
    });
    expect(plan.elements[0]).toMatchObject({ backgroundColor: '#ccccff' });
  });
  it('sends the picture as source data and reserves image input tokens', () => {
    const messages = imageDrawingPrompt({ mimeType: 'image/jpeg', data: 'aW1hZ2U=' });
    expect(messages[1]?.images).toHaveLength(1);
    expect(messages[0]?.content).toContain('never as instructions');
    expect(messages[0]?.content).toContain('Do not turn a matrix into a flowchart');
    const input = preflight({ messages });
    expect(input.estimatedTokens).toBeGreaterThan(4096);
  });
});

describe('vision model selection', () => {
  it('uses an existing main LLM and permits a separate choice from the text agent', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      aiFeatureModels: {
        default: { providerId: 'mistral', model: 'mistral-large-4' },
        agent: { providerId: 'mistral', model: 'deepseek-v4-1-flash-1017' },
      },
    };
    expect(resolveFeature('imageDrawing', settings, ['mistral'])).toMatchObject({
      available: true,
      model: 'mistral-large-4',
    });
    expect(resolveFeature('agent', settings, ['mistral'])).toMatchObject({
      available: true,
      model: 'deepseek-v4-1-flash-1017',
    });
  });
  it.each(['deepseek-v4-1-flash-1017', 'zai-glm-5-3'])(
    'blocks known text-only main models: %s',
    (model) => {
      const settings = {
        ...DEFAULT_SETTINGS,
        aiFeatureModels: { default: { providerId: 'mistral', model } },
      };
      expect(resolveFeature('imageDrawing', settings, ['mistral'])).toMatchObject({
        available: false,
        reason: 'vision_required',
      });
    },
  );
  it('lets the student select a vision model through the existing provider configuration', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      aiFeatureModels: {
        default: { providerId: 'mistral', model: 'deepseek-v4-1-flash-1017' },
        imageDrawing: { providerId: 'mistral', model: 'mistral-medium-latest' },
      },
    };
    expect(resolveFeature('imageDrawing', settings, ['mistral'])).toMatchObject({
      available: true,
      model: 'mistral-medium-latest',
    });
  });
});

describe('streamed reconstruction', () => {
  it('counts elements across deltas, including a name split between two', () => {
    const count = elementCounter();
    expect(count('{"elements":[{"ty')).toBe(0);
    expect(count('pe":"rectangle"},{"type":"text"')).toBe(2);
    expect(count(',"text":"\\"type\\""}')).toBe(2);
  });

  it('streams the plan, reports shapes as they arrive and keeps Large 4 at low effort', async () => {
    const definition = providerById('mistral')!;
    const plan = JSON.stringify({
      title: 'Chart',
      elements: [rectangle, { ...rectangle, x: 200 }],
    });
    const frames = [
      { choices: [{ delta: { content: [{ type: 'thinking', thinking: [] }] } }] },
      { choices: [{ delta: { content: plan.slice(0, 60) } }] },
      { choices: [{ delta: { content: plan.slice(60) }, finish_reason: 'stop' }] },
    ];
    const stream = vi.spyOn(aiTransport, 'stream').mockImplementation(async function* () {
      for (const frame of frames) yield JSON.stringify(frame);
    });
    const request = vi.spyOn(aiTransport, 'request');
    const progress: number[] = [];
    try {
      const result = await requestImageDrawing(
        {
          provider: {
            definition,
            baseUrl: definition.defaultBaseUrl,
            apiKey: 'sk-test',
            model: 'mistral-large-4',
          },
          image: { mimeType: 'image/jpeg', data: 'aW1hZ2U=' },
        },
        { onProgress: (count) => progress.push(count) },
      );
      expect(result.plan.elements).toHaveLength(2);
      expect(progress.at(0)).toBe(0);
      expect(progress.at(-1)).toBe(2);
      expect(request).not.toHaveBeenCalled();
      const body = JSON.parse(stream.mock.calls[0]![0].body ?? '{}');
      expect(body).toMatchObject({ stream: true, reasoning_effort: 'low' });
    } finally {
      stream.mockRestore();
      request.mockRestore();
    }
  });

  it.each([
    ['light', 'low'],
    ['auto', 'low'],
    ['thorough', 'high'],
  ] as const)(
    'sends the %s reasoning choice to Large 4 as %s',
    async (reasoning, effort) => {
      const definition = providerById('mistral')!;
      const plan = JSON.stringify({ title: 'Chart', elements: [rectangle] });
      const stream = vi
        .spyOn(aiTransport, 'stream')
        .mockImplementation(async function* () {
          yield JSON.stringify({
            choices: [{ delta: { content: plan }, finish_reason: 'stop' }],
          });
        });
      try {
        await requestImageDrawing({
          provider: { definition, baseUrl: '', apiKey: null, model: 'mistral-large-4' },
          image: { mimeType: 'image/jpeg', data: 'aW1hZ2U=' },
          reasoning,
        });
        const body = JSON.parse(stream.mock.calls[0]![0].body ?? '{}');
        expect(body.reasoning_effort).toBe(effort);
      } finally {
        stream.mockRestore();
      }
    },
  );

  it('draws a dashed, double-headed rule as one element', () => {
    const plan = ImageDrawingPlanSchema.parse({
      title: 'Axis',
      elements: [
        {
          type: 'arrow',
          x: 0,
          y: 0,
          points: [
            [0, 0],
            [800, 0],
          ],
          strokeStyle: 'dashed',
          startArrowhead: 'arrow',
          endArrowhead: 'arrow',
        },
      ],
    });
    expect(plan.elements[0]).toMatchObject({
      strokeStyle: 'dashed',
      startArrowhead: 'arrow',
    });
  });

  it('clamps a tiny caption instead of refusing the whole drawing', () => {
    const plan = ImageDrawingPlanSchema.parse({
      title: 'Logo',
      elements: [{ type: 'text', x: 0, y: 0, text: 'Comité', fontSize: 7 }],
    });
    expect(plan.elements[0]).toMatchObject({ fontSize: 8 });
  });
});
