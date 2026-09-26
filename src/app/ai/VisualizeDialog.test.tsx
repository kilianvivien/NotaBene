import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { VisualizeDialog } from './VisualizeDialog';

vi.mock('./useAiAvailability', () => ({
  useAiAvailability: () => ({
    available: true,
    definition: { id: 'test', label: 'Test provider' },
    baseUrl: 'https://example.test',
    model: 'test-model',
  }),
  isLocalAvailability: () => false,
}));

const proposeMindMapCommand = vi.fn();
const proposeDiagramCommand = vi.fn();
const insertMindMapCommand = vi.fn();
const insertDiagramCommand = vi.fn();

vi.mock('@/lib/commands', () => ({
  proposeMindMapCommand: (...args: unknown[]) => proposeMindMapCommand(...args),
  proposeDiagramCommand: (...args: unknown[]) => proposeDiagramCommand(...args),
  insertMindMapCommand: (...args: unknown[]) => insertMindMapCommand(...args),
  insertDiagramCommand: (...args: unknown[]) => insertDiagramCommand(...args),
}));

const MAP = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  map: { title: 'Cell', nodes: [{ id: 'a' }, { id: 'b' }], edges: [] },
};
const DIAGRAM = {
  scene: { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  answer: { title: 'Glycolysis', kind: 'flowchart' },
};

beforeEach(() => {
  proposeMindMapCommand.mockResolvedValue({ ok: true, value: MAP });
  proposeDiagramCommand.mockResolvedValue({ ok: true, value: DIAGRAM });
  insertMindMapCommand.mockResolvedValue({ ok: true, value: undefined });
  insertDiagramCommand.mockResolvedValue({ ok: true, value: undefined });
  useEditorStore.setState({
    note: { id: 'n1', title: 'Cell biology' },
  } as unknown as ReturnType<typeof useEditorStore.getState>);
});

afterEach(() => {
  vi.clearAllMocks();
  useUiStore.getState().setAiMindMapOpen(false);
  useUiStore.getState().setAiDiagramOpen(false);
});

function checked(name: string): boolean {
  return screen.getByRole('radio', { name }).getAttribute('aria-checked') === 'true';
}

describe('VisualizeDialog', () => {
  it('opens on the style its menu item names', async () => {
    render(<VisualizeDialog />);
    await act(async () => useUiStore.getState().setAiDiagramOpen(true));
    expect(checked('Diagram')).toBe(true);
    expect(checked('Mind map')).toBe(false);
  });

  it('generates and inserts a mind map through the mind map commands', async () => {
    render(<VisualizeDialog />);
    await act(async () => useUiStore.getState().setAiMindMapOpen(true));

    await userEvent.click(screen.getByRole('button', { name: /Generate mind map/ }));
    await screen.findByText(/Cell · 2 nodes/);
    expect(proposeDiagramCommand).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Insert into note' }));
    await waitFor(() => expect(insertMindMapCommand).toHaveBeenCalledWith('n1', MAP));
    expect(useUiStore.getState().aiMindMapOpen).toBe(false);
  });

  it('switches to a diagram and keeps its own output', async () => {
    render(<VisualizeDialog />);
    await act(async () => useUiStore.getState().setAiMindMapOpen(true));

    await userEvent.click(screen.getByRole('radio', { name: 'Diagram' }));
    await userEvent.click(screen.getByRole('button', { name: /Generate diagram/ }));
    await screen.findByText(/Glycolysis · Flowchart/);

    await userEvent.click(screen.getByRole('button', { name: 'Insert into note' }));
    await waitFor(() => expect(insertDiagramCommand).toHaveBeenCalledWith('n1', DIAGRAM));
    expect(insertMindMapCommand).not.toHaveBeenCalled();
  });
});
