import { describe, expect, it } from 'vitest';
import { ImageDrawingPlanSchema } from '@/lib/schema';
import { imageDrawingPrompt } from './imageDrawing';
import { preflight } from './client';
import { resolveFeature } from './resolve';
import { DEFAULT_SETTINGS } from '@/lib/adapters/settings/SettingsAdapter';

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
