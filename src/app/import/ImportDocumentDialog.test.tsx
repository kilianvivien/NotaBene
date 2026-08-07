import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secrets } from '@/lib/adapters';
import type { ImportedDocument } from '@/lib/schema';
import { endRun, useAiStore } from '@/lib/state/aiStore';
import { useUiStore } from '@/lib/state/uiStore';
import { ImportDocumentDialog } from './ImportDocumentDialog';

const imported: ImportedDocument = {
  source: { filename: 'lecture.pdf', format: 'pdf' },
  markdown: 'Photosynthesis\n\nIt converts light into chemical energy.',
  assets: [],
  metadata: { title: 'Photosynthesis' },
  diagnostics: { parser: 'anydoc', warnings: [], requiresOcr: false },
};

const laidOut = '## Photosynthesis\n\nIt converts light into chemical energy.';

const extractDocumentCommand = vi.fn();
const reformatDocumentCommand = vi.fn();
const createImportedNoteCommand = vi.fn();

vi.mock('@/lib/commands', () => ({
  extractDocumentCommand: (...args: unknown[]) => extractDocumentCommand(...args),
  reformatDocumentCommand: (...args: unknown[]) => reformatDocumentCommand(...args),
  createImportedNoteCommand: (...args: unknown[]) => createImportedNoteCommand(...args),
}));

beforeEach(async () => {
  extractDocumentCommand.mockResolvedValue({ ok: true, value: imported });
  reformatDocumentCommand.mockResolvedValue({
    ok: true,
    value: { markdown: laidOut, applied: 1, rejected: 0 },
  });
  createImportedNoteCommand.mockResolvedValue({
    ok: true,
    value: { note: { id: 'n1' }, attachmentKept: true },
  });
  // A provider with a key on file, so the toggle is live rather than disabled.
  await secrets.set('ai.anthropic.apiKey', 'test-key');
  await useAiStore.getState().refreshProviders();
  useUiStore.getState().setDocumentImportSource({
    kind: 'path',
    path: '/tmp/lecture.pdf',
    name: 'lecture.pdf',
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  // `running` is global session state, so a test that leaves a run open would
  // leave every later dialog with its controls disabled.
  endRun('importFormat');
  useUiStore.getState().setDocumentImportSource(null);
  await secrets.remove('ai.anthropic.apiKey');
});

/** Render, and wait for the extraction the dialog runs on open. */
async function open(): Promise<HTMLElement> {
  render(<ImportDocumentDialog />);
  return waitFor(() => screen.getByRole('switch', { name: 'Let AI lay the note out' }));
}

/** The preview's own heading — the visible difference between the converted
 * document and the laid-out one. The dialog's chrome has headings of its own,
 * so this asks for the title by name. */
function previewHeading(): HTMLElement | null {
  return screen.queryByRole('heading', { name: 'Photosynthesis' });
}

describe('ImportDocumentDialog reformatting', () => {
  it('offers the pass switched off, and asks for nothing until it is switched on', async () => {
    const control = await open();

    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.hasAttribute('disabled')).toBe(false);
    expect(reformatDocumentCommand).not.toHaveBeenCalled();
    expect(previewHeading()).toBeNull();
  });

  it('lays the document out on request and reverts without asking twice', async () => {
    const user = userEvent.setup();
    const control = await open();

    await user.click(control);
    await waitFor(() => expect(previewHeading()).not.toBeNull());
    expect(reformatDocumentCommand).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText('1 block laid out. The wording is unchanged.'),
    ).not.toBeNull();

    await user.click(control);
    await waitFor(() => expect(previewHeading()).toBeNull());

    // Back on again: the result is kept, so comparing the two versions is free.
    await user.click(control);
    await waitFor(() => expect(previewHeading()).not.toBeNull());
    expect(reformatDocumentCommand).toHaveBeenCalledTimes(1);
  });

  it('says nothing about failure when the student cancels the pass', async () => {
    let finish: (value: unknown) => void = () => {};
    reformatDocumentCommand.mockImplementation(
      (_document: unknown, options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ ok: false, code: 'invalid_input', message: 'cancelled' });
          options.signal.addEventListener('abort', () => finish(null), { once: true });
        }),
    );

    const user = userEvent.setup();
    const control = await open();

    await user.click(control);
    await waitFor(() =>
      expect(screen.getByText('Laying the document out…')).not.toBeNull(),
    );

    // The toggle is disabled while the pass runs; the note beside it carries
    // the way out.
    await user.click(
      screen.getByRole('button', { name: 'Stop laying the document out' }),
    );
    finish(null);

    await waitFor(() =>
      expect(screen.queryByText('Laying the document out…')).toBeNull(),
    );
    expect(
      screen.queryByText('The document could not be laid out. The original is shown.'),
    ).toBeNull();
    expect(control.getAttribute('aria-checked')).toBe('false');
  });

  it('creates the note from the converted document while the toggle is off', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() =>
      expect(createImportedNoteCommand).toHaveBeenLastCalledWith(
        imported,
        expect.anything(),
        true,
        null,
      ),
    );
  });

  it('creates the note from the laid-out Markdown once the toggle is on', async () => {
    const user = userEvent.setup();
    const control = await open();

    await user.click(control);
    await waitFor(() => expect(previewHeading()).not.toBeNull());

    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() =>
      expect(createImportedNoteCommand).toHaveBeenLastCalledWith(
        imported,
        expect.anything(),
        true,
        laidOut,
      ),
    );
  });

  it('keeps the original and says so when the model rewrote the text instead', async () => {
    reformatDocumentCommand.mockResolvedValue({
      ok: true,
      value: { markdown: imported.markdown, applied: 0, rejected: 3 },
    });
    const user = userEvent.setup();
    const control = await open();

    await user.click(control);
    await waitFor(() =>
      expect(
        screen.getByText(
          'The model rewrote the text instead of laying it out, so nothing was kept. The original is shown.',
        ),
      ).not.toBeNull(),
    );
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(previewHeading()).toBeNull();
  });

  it('disables the toggle when no provider is configured', async () => {
    await secrets.remove('ai.anthropic.apiKey');
    await useAiStore.getState().refreshProviders();

    const control = await open();
    await waitFor(() => expect(control.hasAttribute('disabled')).toBe(true));
  });
});
