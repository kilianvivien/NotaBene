import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { RewriteDialog } from './RewriteDialog';

vi.mock('./useAiAvailability', () => ({
  useAiAvailability: () => ({
    available: true,
    definition: { id: 'test', label: 'Test provider' },
    baseUrl: 'https://example.test',
    model: 'test-model',
  }),
  isLocalAvailability: () => false,
}));

const proposeRewriteCommand = vi.fn();
const applyRewriteCommand = vi.fn();

vi.mock('@/lib/commands', () => ({
  proposeRewriteCommand: (...args: unknown[]) => proposeRewriteCommand(...args),
  applyRewriteCommand: (...args: unknown[]) => applyRewriteCommand(...args),
}));

beforeEach(() => {
  proposeRewriteCommand.mockResolvedValue({
    ok: true,
    value: { proposal: { blocks: [] }, summary: undefined, before: [] },
  });
  useEditorStore.setState({
    note: { id: 'n1', title: 'Oscillations' },
  } as unknown as ReturnType<typeof useEditorStore.getState>);
  useUiStore.getState().setPendingRewriteMode(null);
  useUiStore.getState().setAiRewriteOpen(true);
});

afterEach(() => {
  vi.clearAllMocks();
  useUiStore.getState().setAiRewriteOpen(false);
  useUiStore.getState().setPendingRewriteMode(null);
});

/** The mode segments are radios inside the segmented control. */
function segment(name: string): HTMLElement {
  return screen.getByRole('radio', { name });
}

/** `aria-checked`, which is what the control actually sets — these are
 *  buttons in a radiogroup, not `<input type="radio">`. */
function selected(name: string): boolean {
  return segment(name).getAttribute('aria-checked') === 'true';
}

describe('RewriteDialog study mode', () => {
  it('offers study notes as a fourth mode, always', async () => {
    // Unconditional on purpose: a segment that appears only after an import
    // reads as a bug rather than as something not yet unlocked.
    render(<RewriteDialog />);
    expect(segment('Study notes')).not.toBeNull();
  });

  it('starts on the safe mode when nothing asked for another', () => {
    render(<RewriteDialog />);
    expect(selected('Light cleanup')).toBe(true);
    expect(selected('Study notes')).toBe(false);
  });

  it('says plainly that this mode changes the wording', async () => {
    // The other three promise the author's words survive. This one does not,
    // and that sentence is the only thing between two adjacent choices.
    render(<RewriteDialog />);
    expect(screen.queryByText(/changes the wording/)).toBeNull();

    await userEvent.click(segment('Study notes'));

    expect(screen.getByText(/this one changes the wording/)).not.toBeNull();
  });

  it('opens in study mode when the import handed it off', async () => {
    useUiStore.getState().setAiRewriteOpen(false);
    useUiStore.getState().setPendingRewriteMode('study');
    render(<RewriteDialog />);
    useUiStore.getState().setAiRewriteOpen(true);

    await waitFor(() => expect(selected('Study notes')).toBe(true));
  });

  it('clears the handed-off mode, so opening it by hand is light again', async () => {
    useUiStore.getState().setAiRewriteOpen(false);
    useUiStore.getState().setPendingRewriteMode('study');
    render(<RewriteDialog />);

    useUiStore.getState().setAiRewriteOpen(true);
    await waitFor(() => expect(selected('Study notes')).toBe(true));
    expect(useUiStore.getState().pendingRewriteMode).toBeNull();

    // Close and reopen by hand, letting React settle between the two — back
    // to back they batch into no change at all, and the reopen never happens.
    await act(async () => {
      useUiStore.getState().setAiRewriteOpen(false);
    });
    await act(async () => {
      useUiStore.getState().setAiRewriteOpen(true);
    });

    // A mode nobody chose this time must not stick.
    expect(selected('Light cleanup')).toBe(true);
  });

  it('proposes in the mode that is selected', async () => {
    render(<RewriteDialog />);
    await userEvent.click(segment('Study notes'));
    await userEvent.click(screen.getByRole('button', { name: 'Propose changes' }));

    await waitFor(() => expect(proposeRewriteCommand).toHaveBeenCalled());
    expect(proposeRewriteCommand.mock.calls[0]?.[0]).toMatchObject({
      noteId: 'n1',
      mode: 'study',
    });
  });
});
