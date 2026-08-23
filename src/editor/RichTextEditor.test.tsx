import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
