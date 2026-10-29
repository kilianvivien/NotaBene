import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import type { NoteDoc } from '@/lib/schema';
import { RichTextEditor } from './RichTextEditor';

const doc: NoteDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original' }] }],
};

describe('RichTextEditor change tracking', () => {
  it('does not report the initial document as an edit', async () => {
    const onChange = vi.fn();

    render(<RichTextEditor doc={doc} onChange={onChange} />);

    expect(await screen.findByText('Original')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports an actual document edit', async () => {
    const onChange = vi.fn();

    render(<RichTextEditor doc={doc} onChange={onChange} />);
    await screen.findByText('Original');
    fireEvent.click(screen.getByRole('button', { name: 'Bulleted list' }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('preserves externally applied document metadata on the next edit', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<RichTextEditor doc={doc} onChange={onChange} />);
    await screen.findByText('Original');

    const targeted: NoteDoc = { ...doc, attrs: { writingTarget: 250 } };
    rerender(<RichTextEditor doc={targeted} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bulleted list' }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ attrs: { writingTarget: 250 } }),
      ),
    );
  });
});

describe('image context action', () => {
  it('targets the right-clicked image and opens its drawing preview flow', async () => {
    const imageDoc: NoteDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
        { type: 'image', attrs: { assetId: 'inline-picture', caption: 'Matrix' } },
      ],
    };
    useEditorStore.setState({ note: { id: 'image-note' } } as unknown as ReturnType<
      typeof useEditorStore.getState
    >);
    const { container } = render(<RichTextEditor doc={imageDoc} onChange={vi.fn()} />);
    const frame = container.querySelector('.nb-asset-image-frame');
    expect(frame).not.toBeNull();
    fireEvent.contextMenu(frame!, { clientX: 100, clientY: 120 });
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Recreate as editable drawing…' }),
    );
    await waitFor(() =>
      expect(useUiStore.getState().imageDrawingTarget).toMatchObject({
        noteId: 'image-note',
        path: [1],
        image: { type: 'image', attrs: { assetId: 'inline-picture' } },
      }),
    );
    useUiStore.getState().setImageDrawingTarget(null);
    useEditorStore.setState({ note: null });
  });
});
