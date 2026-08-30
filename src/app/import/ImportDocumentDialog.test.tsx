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
const ocrAvailableCommand = vi.fn();
const ocrLanguagesCommand = vi.fn();
const runOcrCommand = vi.fn();

vi.mock('@/lib/commands', () => ({
  extractDocumentCommand: (...args: unknown[]) => extractDocumentCommand(...args),
  reformatDocumentCommand: (...args: unknown[]) => reformatDocumentCommand(...args),
  createImportedNoteCommand: (...args: unknown[]) => createImportedNoteCommand(...args),
  ocrAvailableCommand: (...args: unknown[]) => ocrAvailableCommand(...args),
  ocrLanguagesCommand: (...args: unknown[]) => ocrLanguagesCommand(...args),
  runOcrCommand: (...args: unknown[]) => runOcrCommand(...args),
}));

beforeEach(async () => {
  extractDocumentCommand.mockResolvedValue({ ok: true, value: imported });
  ocrAvailableCommand.mockResolvedValue(true);
  ocrLanguagesCommand.mockResolvedValue({ ok: true, value: ['en-US', 'fr-FR'] });
  reformatDocumentCommand.mockResolvedValue({
    ok: true,
    value: { markdown: laidOut, applied: 1, rejected: 0 },
  });
  createImportedNoteCommand.mockResolvedValue({
    ok: true,
    value: { note: { id: 'n1' }, attachmentKept: true, imagesKept: 0, warnings: [] },
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

describe('ImportDocumentDialog scanned pages', () => {
  /** The conversion failure a scanned PDF produces, with its page list. */
  function needsOcr(pages: number[], pageCount: number) {
    extractDocumentCommand.mockResolvedValue({
      ok: false,
      code: 'not_supported',
      message: 'ocr_required',
      details: { pages, pageCount },
    });
  }

  /** Render and wait for the offer rather than the reformat toggle: with the
   * conversion refused there is no document, so that switch never appears. */
  async function openScanned(): Promise<HTMLElement> {
    render(<ImportDocumentDialog />);
    return waitFor(() => screen.getByRole('button', { name: 'Read the scanned pages' }));
  }

  it('offers to read the scanned pages, saying how many of how many', async () => {
    needsOcr([1, 5, 7], 12);
    await openScanned();
    expect(screen.getByText(/3 of the 12 pages are scanned/)).not.toBeNull();
  });

  it('offers no red failure alongside the offer', async () => {
    // A refusal and an invitation at the same time is the confusing state
    // this replaced: the panel explains itself, so the error line stays away.
    needsOcr([2], 4);
    await openScanned();
    expect(screen.queryByText(/cannot read them/)).toBeNull();
  });

  it('reads exactly the pages the conversion named', async () => {
    needsOcr([1, 5, 7], 12);
    runOcrCommand.mockResolvedValue({
      ok: true,
      value: { document: imported, read: 3, blank: 0 },
    });
    await openScanned();

    await userEvent.click(screen.getByRole('button', { name: 'Read the scanned pages' }));

    await waitFor(() => expect(runOcrCommand).toHaveBeenCalled());
    expect(runOcrCommand.mock.calls[0]?.[1]).toEqual([1, 5, 7]);
  });

  it('shows the converted document once the pages have been read', async () => {
    needsOcr([1], 2);
    runOcrCommand.mockResolvedValue({
      ok: true,
      value: { document: imported, read: 1, blank: 0 },
    });
    await openScanned();

    await userEvent.click(screen.getByRole('button', { name: 'Read the scanned pages' }));

    await waitFor(() =>
      expect(
        screen.getByText(/It converts light into chemical energy/),
      ).not.toBeNull(),
    );
    // The offer is gone rather than merely disabled: there is nothing left to
    // offer once the pages are read.
    expect(
      screen.queryByRole('button', { name: 'Read the scanned pages' }),
    ).toBeNull();
  });

  it('says plainly when a page was read and turned out blank', async () => {
    needsOcr([1, 2], 2);
    runOcrCommand.mockResolvedValue({
      ok: true,
      value: { document: imported, read: 1, blank: 1 },
    });
    await openScanned();

    await userEvent.click(screen.getByRole('button', { name: 'Read the scanned pages' }));

    await waitFor(() =>
      expect(
        screen.getByText(/1 scanned page had no readable text on it/),
      ).not.toBeNull(),
    );
  });

  it('passes the chosen language, and none when the student leaves it automatic', async () => {
    needsOcr([1], 1);
    runOcrCommand.mockResolvedValue({
      ok: true,
      value: { document: imported, read: 1, blank: 0 },
    });
    await openScanned();

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Language of the scanned pages' }),
      'fr-FR',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Read the scanned pages' }));

    await waitFor(() => expect(runOcrCommand).toHaveBeenCalled());
    expect(runOcrCommand.mock.calls[0]?.[2]).toMatchObject({ languages: ['fr-FR'] });
  });

  it('hides the offer and says so on a build that cannot read a page', async () => {
    ocrAvailableCommand.mockResolvedValue(false);
    needsOcr([1], 3);
    render(<ImportDocumentDialog />);

    await waitFor(() =>
      expect(screen.getByText(/cannot read them/)).not.toBeNull(),
    );
    expect(
      screen.queryByRole('button', { name: 'Read the scanned pages' }),
    ).toBeNull();
  });

  it('counts pages while it runs and offers a way out', async () => {
    needsOcr([1, 2, 3], 3);
    runOcrCommand.mockImplementation(
      async (_source: unknown, _pages: unknown, options: { onProgress?: (p: unknown) => void }) => {
        options.onProgress?.({ done: 2, total: 3 });
        return new Promise(() => {});
      },
    );
    await openScanned();

    await userEvent.click(screen.getByRole('button', { name: 'Read the scanned pages' }));

    await waitFor(() =>
      expect(screen.getByText(/Reading page 2 of 3/)).not.toBeNull(),
    );
    expect(
      screen.getByRole('button', { name: 'Stop reading the scanned pages' }),
    ).not.toBeNull();
  });
});
