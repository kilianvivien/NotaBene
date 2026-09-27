import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFolderImportAdapter } from '@/lib/adapters/folderImport/memoryFolderImportAdapter';
import { createFolderSource } from '@/lib/import/sources/folderSource';
import { planSourceImport } from '@/lib/import/sources/plan';
import { useUiStore } from '@/lib/state/uiStore';
import { ImportSourceDialog } from './ImportSourceDialog';

const pickSourceCommand = vi.fn();
const scanSourceCommand = vi.fn();
const planSourceImportCommand = vi.fn();
const applySourceImportCommand = vi.fn();

vi.mock('@/lib/commands', () => ({
  pickSourceCommand: (...args: unknown[]) => pickSourceCommand(...args),
  scanSourceCommand: (...args: unknown[]) => scanSourceCommand(...args),
  planSourceImportCommand: (...args: unknown[]) => planSourceImportCommand(...args),
  applySourceImportCommand: (...args: unknown[]) => applySourceImportCommand(...args),
  sourceAvailable: () => true,
}));

beforeEach(async () => {
  const adapter = createMemoryFolderImportAdapter({
    '/vault': {
      'Index.md': 'Start with [[Week 4]]. #hub',
      'Physics/Week 4.md': 'Damping.',
      'Maths/Series.md': 'Sums.',
    },
  });
  const scan = await createFolderSource('obsidian', () => adapter).scan('/vault');
  pickSourceCommand.mockResolvedValue({ ok: true, value: '/vault' });
  scanSourceCommand.mockResolvedValue({ ok: true, value: scan });
  planSourceImportCommand.mockImplementation(async (value, sourceId, existing) => ({
    ok: true,
    value: planSourceImport(value, { sourceId, imported: [], titles: [], existing }),
  }));
  applySourceImportCommand.mockResolvedValue({
    ok: true,
    value: {
      created: 3,
      updated: 0,
      skipped: 0,
      images: 0,
      imagesFailed: 0,
      coursesCreated: 2,
      courseId: null,
    },
  });
  useUiStore.getState().setSourceImportOpen(true);
});

describe('ImportSourceDialog', () => {
  it('offers the three sources it can read, and no others', () => {
    render(<ImportSourceDialog />);
    expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      expect.stringContaining('Obsidian vault'),
      expect.stringContaining('Markdown folder'),
      expect.stringContaining('Notion export'),
    ]);
    expect(screen.queryByRole('radio', { name: /Apple Notes/ })).toBeNull();
  });

  it('previews before writing, then imports with the mapping chosen', async () => {
    const user = userEvent.setup();
    render(<ImportSourceDialog />);
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));

    // Nothing is written until the button that says how many.
    await screen.findByText('Physics/Week 4.md');
    expect(applySourceImportCommand).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole('radio', { name: 'Folders become courses' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    screen.getByText(/Maths, Physics\./);

    await user.click(screen.getByRole('radio', { name: 'Into the inbox' }));
    await user.click(screen.getByRole('button', { name: 'Import 3 notes' }));

    await waitFor(() => expect(applySourceImportCommand).toHaveBeenCalledTimes(1));
    expect(applySourceImportCommand.mock.calls[0]![1]).toMatchObject({
      mapping: { kind: 'inbox' },
      keepTags: true,
    });
    await screen.findByText(/3 notes imported\./);
  });

  it('says why a scan was refused', async () => {
    scanSourceCommand.mockResolvedValue({
      ok: false,
      code: 'not_supported',
      message: 'notionHtml',
    });
    const user = userEvent.setup();
    render(<ImportSourceDialog />);
    await user.click(screen.getByRole('radio', { name: 'Notion export' }));
    await user.click(screen.getByRole('button', { name: 'Choose .zip file…' }));
    await screen.findByText(/Notion’s HTML export/);
  });
});
