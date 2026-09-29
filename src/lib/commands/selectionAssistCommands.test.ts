import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proposeSelectionAssistCommand } from './selectionAssistCommands';
import { providerFor } from './aiCommands';
import { runStructured } from '@/lib/ai/structured';
vi.mock('./aiCommands', () => ({
  providerFor: vi.fn(),
  language: () => 'en',
  aiFailure: () => ({ ok: false, code: 'invalid_input', message: 'Provider failed' }),
}));
vi.mock('@/lib/ai/structured', () => ({ runStructured: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(providerFor).mockResolvedValue({ ok: true, provider: {} as never });
  vi.mocked(runStructured).mockResolvedValue({ text: 'Corrected text.' });
});
describe('selection AI proposals', () => {
  it('sends only the captured selection to the selected feature provider', async () => {
    const result = await proposeSelectionAssistCommand({
      text: 'Selected text.',
      mode: 'correct',
    });
    expect(result).toEqual({ ok: true, value: 'Corrected text.' });
    expect(providerFor).toHaveBeenCalledWith('proofread');
    expect(vi.mocked(runStructured).mock.calls[0]?.[0].messages[1]).toEqual({
      role: 'user',
      content: 'Selected text.',
    });
  });
  it('uses the rewrite provider for rewriting', async () => {
    await proposeSelectionAssistCommand({ text: 'Selected text.', mode: 'rewrite' });
    expect(providerFor).toHaveBeenCalledWith('rewrite');
  });
  it('refuses oversized selections before contacting any provider', async () => {
    const result = await proposeSelectionAssistCommand({
      text: 'x'.repeat(4001),
      mode: 'correct',
    });
    expect(result.ok).toBe(false);
    expect(providerFor).not.toHaveBeenCalled();
    expect(runStructured).not.toHaveBeenCalled();
  });
  it('does not call a model when no provider is configured', async () => {
    vi.mocked(providerFor).mockResolvedValue({ ok: false, reason: 'not_configured' });
    expect(
      (await proposeSelectionAssistCommand({ text: 'Text', mode: 'rewrite' })).ok,
    ).toBe(false);
    expect(runStructured).not.toHaveBeenCalled();
  });
});
