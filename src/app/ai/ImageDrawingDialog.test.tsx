import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { useAiStore } from '@/lib/state/aiStore';
import { ImageDrawingDialog } from './ImageDrawingDialog';

const mocks = vi.hoisted(() => ({ propose: vi.fn(), insert: vi.fn() }));
vi.mock('@/lib/commands', () => ({
  proposeImageDrawingCommand: mocks.propose,
  insertImageDrawingCommand: mocks.insert,
}));
vi.mock('@/lib/adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adapters')>()),
  assets: { get: async () => null },
}));
vi.mock('./useAiAvailability', () => ({
  useAiAvailability: () => ({
    available: true,
    definition: { id: 'mistral', label: 'Mistral' },
    model: 'vision-model',
  }),
  isLocalAvailability: () => false,
}));
const target = {
  noteId: 'n1',
  path: [1],
  image: { type: 'image', attrs: { assetId: 'image', alt: 'Delegation' } },
};
const result = {
  plan: { title: 'Delegation', warnings: ['Check the lower label'] },
  scene: { svg: '<svg />' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.propose.mockResolvedValue({ ok: true, value: result });
  mocks.insert.mockResolvedValue({ ok: true });
  useEditorStore.setState({ note: { id: 'n1' } } as unknown as ReturnType<
    typeof useEditorStore.getState
  >);
  useAiStore.setState({ running: null });
  useUiStore.getState().setImageDrawingTarget(target);
});
afterEach(() => {
  useUiStore.getState().setImageDrawingTarget(null);
});

describe('image drawing preview', () => {
  it('previews the result and its uncertainty before an explicit replacement', async () => {
    render(<ImageDrawingDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Recreate drawing' }));
    await screen.findByText('Editable drawing');
    expect(screen.getByText('Check the lower label')).toBeTruthy();
    expect(mocks.insert).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Replace image' }));
    await waitFor(() =>
      expect(mocks.insert).toHaveBeenCalledWith(target, result, 'replace'),
    );
    expect(useUiStore.getState().imageDrawingTarget).toBeNull();
  });
  it('offers insertion below the source image', async () => {
    render(<ImageDrawingDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Recreate drawing' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Insert below image' }),
    );
    expect(mocks.insert).toHaveBeenCalledWith(target, result, 'after');
  });
  it('discards a late model result after the note changes', async () => {
    let resolve!: (value: unknown) => void;
    mocks.propose.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<ImageDrawingDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Recreate drawing' }));
    await act(async () =>
      useEditorStore.setState({ note: { id: 'n2' } } as unknown as ReturnType<
        typeof useEditorStore.getState
      >),
    );
    await act(async () => resolve({ ok: true, value: result }));
    expect(useUiStore.getState().imageDrawingTarget).toBeNull();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(screen.queryByText('Editable drawing')).toBeNull();
  });
});
