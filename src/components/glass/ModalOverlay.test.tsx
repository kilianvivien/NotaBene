/**
 * Focus, which is the whole of what this component owes a dialog.
 *
 * Both cases here are the same bug seen from two sides. `DefineDialog` builds
 * its `onClose` fresh on every render — it cancels the run before closing — and
 * that used to be a dependency of the focus effect, so every render tore the
 * effect down and its cleanup handed focus back to whatever was focused before
 * the dialog opened. From the editor that is ProseMirror, which re-renders the
 * editor on the resulting transaction, which re-renders the dialog: the student
 * typed into their note instead of into the dialog, and React eventually
 * stopped it with "maximum update depth exceeded".
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModalOverlay } from './ModalOverlay';

function Harness({ open, tick }: { open: boolean; tick: number }) {
  // Re-created every render, exactly as a dialog that closes over something
  // does. `tick` only exists to make the parent render again.
  const onClose = () => undefined;
  return (
    <>
      <button type="button" data-testid="opener">
        Define… {tick}
      </button>
      <ModalOverlay open={open} onClose={onClose} label="Define a word">
        <input data-autofocus aria-label="Word to define" />
      </ModalOverlay>
    </>
  );
}

describe('ModalOverlay', () => {
  it('focuses the claimed field as soon as the panel is on screen', () => {
    const { rerender } = render(<Harness open={false} tick={0} />);
    screen.getByTestId('opener').focus();

    rerender(<Harness open tick={0} />);

    expect(document.activeElement).toBe(screen.getByLabelText('Word to define'));
  });

  it('keeps focus in the dialog when the caller re-renders with a new onClose', () => {
    const { rerender } = render(<Harness open={false} tick={0} />);
    screen.getByTestId('opener').focus();
    rerender(<Harness open tick={0} />);

    rerender(<Harness open tick={1} />);
    rerender(<Harness open tick={2} />);

    expect(document.activeElement).toBe(screen.getByLabelText('Word to define'));
  });

  it('hands focus back to where it came from once the dialog closes', () => {
    const { rerender } = render(<Harness open={false} tick={0} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    rerender(<Harness open tick={0} />);

    rerender(<Harness open={false} tick={0} />);

    expect(document.activeElement).toBe(opener);
  });
});

/** A dialog that never claims a field still has to take focus off the page
 * behind it, or Escape and the tab trap have nothing to act on. */
describe('ModalOverlay without a claimed field', () => {
  it('focuses the first control that has not declined', () => {
    function Plain({ open }: { open: boolean }) {
      const [, force] = useState(0);
      return (
        <ModalOverlay open={open} onClose={() => force((n) => n + 1)} label="Wikipedia">
          <div data-modal-focus="skip">
            <button type="button">Status</button>
          </div>
          <button type="button">Search</button>
        </ModalOverlay>
      );
    }
    const { rerender } = render(<Plain open={false} />);
    rerender(<Plain open />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Search' }));
  });
});
