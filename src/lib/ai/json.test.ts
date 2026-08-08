/**
 * What a small local model actually sends back.
 *
 * Every string in this file is a shape a seven-billion-parameter model
 * produces routinely and a frontier model almost never does: a reasoning trace
 * in front of the answer, a fence around it, a trailing comma, a Markdown
 * document written into a string with real newlines in it. Each one used to
 * end the feature with "the model did not return JSON".
 *
 * The last two tests are the guard rails: the schema still refuses what it
 * refused before, and nothing in here may put words into a model's mouth.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJson, parseModelJson } from './json';
import { AiSynthesisResponseSchema } from '@/lib/schema';

const Simple = z.object({ title: z.string(), markdown: z.string() });

describe('reading a model response as JSON', () => {
  it('takes a clean answer as it is', () => {
    const parsed = parseModelJson(Simple, '{"title": "T", "markdown": "body"}');
    expect(parsed).toEqual({ title: 'T', markdown: 'body' });
  });

  it('ignores a reasoning trace, including the braces in it', () => {
    const thought =
      '<think>I should answer with {"title": ..., "markdown": ...} and keep it short.</think>\n' +
      '{"title": "Real", "markdown": "body"}';
    expect(parseModelJson(Simple, thought).title).toBe('Real');
  });

  it('finds the answer under a fence, whatever the fence claims to be', () => {
    expect(parseModelJson(Simple, '```json\n{"title":"T","markdown":"b"}\n```').title).toBe(
      'T',
    );
    expect(parseModelJson(Simple, '```\n{"title":"T","markdown":"b"}\n```').title).toBe(
      'T',
    );
  });

  it('prefers the object that fits when the model showed its plan first', () => {
    const narrated =
      'First I will use this shape: {"shape": "title + markdown"}.\n' +
      'Here it is: {"title": "Real", "markdown": "body"}';
    expect(parseModelJson(Simple, narrated).title).toBe('Real');
  });

  it('forgives a trailing comma', () => {
    expect(parseModelJson(Simple, '{"title": "T", "markdown": "b",}').markdown).toBe('b');
  });

  it('forgives a Markdown document written with real newlines in it', () => {
    const raw = '{"title": "Cours", "markdown": "# Titre\n\n- un\n- deux"}';
    expect(parseModelJson(Simple, raw).markdown).toBe('# Titre\n\n- un\n- deux');
  });

  it('forgives curly quotes used as delimiters', () => {
    expect(parseModelJson(Simple, '{“title”: “T”, “markdown”: “b”}').title).toBe('T');
  });

  it('leaves an apostrophe inside a value exactly as the model wrote it', () => {
    // Legal JSON, and half this app's users write French: repairing it would
    // be repairing content, which is the line this module does not cross.
    const raw = '{"title": "L\'équation", "markdown": "l’état d’un système",}';
    expect(parseModelJson(Simple, raw).markdown).toBe('l’état d’un système');
  });

  it('does not stop at a brace inside a string literal', () => {
    const tricky = '{"title": "a \\" and a }", "markdown": "b"}';
    expect(extractJson(tricky)).toBe(tricky);
    expect(parseModelJson(Simple, tricky).title).toBe('a " and a }');
  });

  it('still refuses what the schema refuses', () => {
    // The endpoint answered with a login page, not a model.
    expect(() =>
      parseModelJson(AiSynthesisResponseSchema, '<!doctype html><title>401</title>'),
    ).toThrow(/did not return JSON/);
    // Valid JSON of the wrong shape is still the wrong shape: repairing
    // punctuation must never turn into repairing content.
    expect(() =>
      parseModelJson(AiSynthesisResponseSchema, '{"title": "T"}'),
    ).toThrow(/did not match the expected shape/);
  });

  it('carries the raw text on failure, so the user can be shown it', () => {
    const raw = 'I would rather not.';
    expect(() => parseModelJson(Simple, raw)).toThrow(
      expect.objectContaining({ raw }) as Error,
    );
  });
});
