import { describe, expect, it } from 'vitest';
import { aiFailure } from './aiCommands';

describe('aiFailure', () => {
  /** `ai.rs` refuses an address the student declined in its dialog; that is
   * their decision, said in their words, not a provider error. */
  it('turns a declined address into a sentence naming it', () => {
    const result = aiFailure(
      new Error('origin_declined:NotaBene was not allowed to contact https://gw.example.edu'),
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'not_supported',
      details: { aiReason: 'origin_declined' },
    });
    if (result.ok) return;
    expect(result.message).toContain('https://gw.example.edu');
    expect(result.message).not.toContain('origin_declined');
  });
});
