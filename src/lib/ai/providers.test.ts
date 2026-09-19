import { describe, expect, it } from 'vitest';
import { modelDisplayName, providerById } from './providers';

describe('modelDisplayName', () => {
  it("gives Apple's transport model id a user-facing name", () => {
    const apple = providerById('apple');
    expect(apple).toBeDefined();
    expect(modelDisplayName(apple!, 'system')).toBe('Apple Intelligence (AFM 3)');
  });

  it('leaves ordinary and unknown model ids unchanged', () => {
    const openAi = providerById('openai');
    expect(openAi).toBeDefined();
    expect(modelDisplayName(openAi!, 'gpt-5.6-terra')).toBe('gpt-5.6-terra');
  });
});
