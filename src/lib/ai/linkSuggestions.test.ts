import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiTransport } from '@/lib/adapters';
import { requestLinkSuggestions, MAX_LINK_SUGGESTIONS } from './linkSuggestions';
import type { ResolvedProvider } from './protocols';
import * as structured from './structured';
import { providerById } from './providers';

afterEach(() => vi.restoreAllMocks());

const NOTES = ['Damping', 'Resonance', 'Week 4', 'Lab 3'].map((title, index) => ({
  id: `n${index}`,
  title,
  course: null,
  excerpt: `${title} begins here.`,
}));

function answering(links: { from: number; to: number; reason: string }[]) {
  return vi.spyOn(structured, 'runStructured').mockResolvedValue({ links });
}

async function suggest(linked: string[] = []) {
  return requestLinkSuggestions({
    provider: {} as ResolvedProvider,
    notes: NOTES,
    linked: new Set(linked),
    language: 'en',
  });
}

describe('requestLinkSuggestions', () => {
  it('turns positions back into notes', async () => {
    answering([{ from: 2, to: 0, reason: 'The lecture introduces it.' }]);
    expect(await suggest()).toEqual([
      { sourceId: 'n2', targetId: 'n0', reason: 'The lecture introduces it.' },
    ]);
  });

  it('drops what no note stands behind: a position off the list, a self-link', async () => {
    answering([
      { from: 9, to: 0, reason: 'invented' },
      { from: 1, to: 1, reason: 'itself' },
      { from: 1, to: 0, reason: 'real' },
    ]);
    expect((await suggest()).map((link) => link.reason)).toEqual(['real']);
  });

  it('keeps one suggestion per pair, whichever way round', async () => {
    answering([
      { from: 1, to: 0, reason: 'first' },
      { from: 0, to: 1, reason: 'again, reversed' },
    ]);
    expect(await suggest()).toHaveLength(1);
  });

  it('never suggests a pair the student already linked, in either direction', async () => {
    answering([
      { from: 1, to: 0, reason: 'already there' },
      { from: 3, to: 2, reason: 'new' },
    ]);
    expect((await suggest(['n0>n1'])).map((link) => link.reason)).toEqual(['new']);
  });

  it('stops at the number a student will read', async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      from: index % 4,
      to: (index + 1 + Math.floor(index / 4)) % 4,
      reason: `r${index}`,
    }));
    answering(many);
    expect((await suggest()).length).toBeLessThanOrEqual(MAX_LINK_SUGGESTIONS);
  });
});

describe('link suggestion provider requests', () => {
  it.each(['mistral-large-4', 'zai-glm-5-3', 'apple', 'lmstudio'])(
    'sends a constrained JSON document for %s and validates the response',
    async (model) => {
      const id = model === 'apple' || model === 'lmstudio' ? model : 'mistral';
      const request = vi.spyOn(aiTransport, 'request').mockResolvedValue({
        status: 200,
        headers: {},
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  links: [
                    { from: 1, to: 0, reason: 'The concept explains the lecture.' },
                  ],
                }),
              },
            },
          ],
        }),
      });
      const result = await requestLinkSuggestions({
        provider: {
          definition: providerById(id)!,
          model,
          baseUrl: 'http://localhost:1234/v1',
          apiKey: null,
        },
        notes: NOTES,
        linked: new Set(['n2>n3']),
        language: 'en',
      });
      expect(result).toEqual([
        { sourceId: 'n1', targetId: 'n0', reason: 'The concept explains the lecture.' },
      ]);
      const sent = JSON.parse(String(request.mock.calls[0]![0].body));
      expect(sent.response_format.type).toBe('json_schema');
      expect(sent.response_format.json_schema.schema.required).toEqual(['links']);
      expect(
        sent.response_format.json_schema.schema.properties.links.items.required,
      ).toEqual(['from', 'to', 'reason']);
      expect(sent.messages[0].content).toContain('[{"from":2,"to":3}]');
      expect(sent.stream).not.toBe(true);
    },
  );

  it('repairs a prose answer once with the same schema', async () => {
    const response = (content: string) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ choices: [{ message: { content } }] }),
    });
    const request = vi
      .spyOn(aiTransport, 'request')
      .mockResolvedValueOnce(response('These notes could be related.'))
      .mockResolvedValueOnce(response('{"links":[]}'));
    await expect(
      requestLinkSuggestions({
        provider: {
          definition: providerById('mistral')!,
          model: 'zai-glm-5-3',
          baseUrl: 'http://localhost:1234/v1',
          apiKey: null,
        },
        notes: NOTES,
        linked: new Set(),
        language: 'en',
      }),
    ).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[1]![0].body)).response_format.type).toBe(
      'json_schema',
    );
  });

  it('does not pay for a call with fewer than two candidates', async () => {
    const request = vi.spyOn(aiTransport, 'request');
    await expect(
      requestLinkSuggestions({
        provider: {} as ResolvedProvider,
        notes: NOTES.slice(0, 1),
        linked: new Set(),
        language: 'en',
      }),
    ).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
