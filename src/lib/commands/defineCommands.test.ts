/**
 * The guard half of the define feature.
 *
 * What the model does with a word is covered where the prompt is. What matters
 * here is what never reaches a provider: an empty selection, and a selection
 * that is a passage rather than a term — the second because "define this"
 * pointed at three paragraphs is a summarisation request in the wrong feature,
 * and it would be answered, slowly, on the student's own key.
 *
 * `invalid_input` versus `not_supported` is what the ordering is read from. No
 * provider is configured in these tests, so anything that reaches the lookup
 * comes back `not_supported`; a term rejected before that says `invalid_input`
 * instead, and could not have cost a request.
 */
import { describe, expect, it } from 'vitest';
import { defineTermCommand, MAX_TERM_WORDS } from './defineCommands';

async function codeFor(input: Parameters<typeof defineTermCommand>[0]): Promise<string> {
  const result = await defineTermCommand(input);
  if (result.ok) throw new Error('expected no provider to be configured');
  return result.code;
}

describe('defineTermCommand', () => {
  it('refuses an empty selection', async () => {
    await expect(codeFor({ term: '   ' })).resolves.toBe('invalid_input');
  });

  it('refuses a passage, before it costs a request', async () => {
    const passage = Array.from({ length: MAX_TERM_WORDS + 1 }, () => 'mot').join(' ');
    await expect(codeFor({ term: passage })).resolves.toBe('invalid_input');
  });

  it('lets a short multi-word term through to the provider', async () => {
    await expect(codeFor({ term: 'ultra vires' })).resolves.toBe('not_supported');
  });

  it('says so plainly when no provider is configured', async () => {
    await expect(
      codeFor({ term: 'syllogisme', context: 'Un raisonnement déductif.' }),
    ).resolves.toBe('not_supported');
  });
});
