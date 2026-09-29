/**
 * The behaviours that make the menu feel like an AppKit one rather than a list
 * of buttons: one highlight shared by pointer and keys, focus left where it was,
 * release-to-choose with the right button, and a dismissing click that does
 * not also land on what is underneath.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';

// jsdom has no PointerEvent, and without one `button` never reaches a handler.
if (typeof window.PointerEvent === 'undefined') {
  // @ts-expect-error — a MouseEvent carries every field these tests read.
  window.PointerEvent = class extends MouseEvent {};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(props: { retainFocus?: boolean; openedByKeyboard?: boolean } = {}) {
  const copy = vi.fn();
  const paste = vi.fn();
  const onClose = vi.fn();
  const items: ContextMenuEntry[] = [
    { id: 'copy', label: 'Copy', onSelect: copy },
    { id: 'disabled', label: 'Cut', disabled: true, onSelect: vi.fn() },
    null,
    { id: 'paste', label: 'Paste', onSelect: paste },
  ];
  const outside = vi.fn();
  render(
    <>
      <textarea aria-label="editor" />
      <button type="button" onClick={outside}>
        outside
      </button>
      <ContextMenu point={{ x: 10, y: 10 }} items={items} onClose={onClose} {...props} />
    </>,
  );
  return { copy, paste, onClose, outside, menu: screen.getByRole('menu') };
}

const key = (key: string) =>
  fireEvent.keyDown(window, { key, bubbles: true, cancelable: true });

describe('ContextMenu', () => {
  it('moves one highlight with arrows, skipping disabled rows, and chooses on Return', () => {
    const { menu, paste, onClose } = setup();
    expect(menu.getAttribute('aria-activedescendant')).toBeNull();
    key('ArrowDown');
    expect(menu.getAttribute('aria-activedescendant')).toBe('nb-menu-item-copy');
    key('ArrowDown');
    expect(menu.getAttribute('aria-activedescendant')).toBe('nb-menu-item-paste');
    key('Enter');
    expect(paste).toHaveBeenCalledOnce();
    // The row blinks before the menu goes.
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(120));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('highlights the row under the pointer and type-selects by label', () => {
    const { menu } = setup();
    fireEvent.pointerMove(screen.getByRole('menuitem', { name: 'Paste' }));
    expect(menu.getAttribute('aria-activedescendant')).toBe('nb-menu-item-paste');
    key('c');
    expect(menu.getAttribute('aria-activedescendant')).toBe('nb-menu-item-copy');
  });

  it('chooses the row the right button is released over', () => {
    const { copy } = setup();
    fireEvent.pointerUp(screen.getByRole('menuitem', { name: 'Copy' }), { button: 2 });
    expect(copy).toHaveBeenCalledOnce();
  });

  it('leaves focus where it was unless opened from the keyboard', () => {
    const { menu } = setup();
    expect(document.activeElement).not.toBe(menu);
  });

  it('takes focus and highlights the first row when opened from the keyboard', () => {
    const { menu } = setup({ openedByKeyboard: true });
    expect(document.activeElement).toBe(menu);
    expect(menu.getAttribute('aria-activedescendant')).toBe('nb-menu-item-copy');
  });

  it('with retainFocus, the dismissing click does not reach what is underneath', () => {
    const { onClose, outside } = setup({ retainFocus: true });
    const target = screen.getByRole('button', { name: 'outside' });
    fireEvent.pointerDown(target, { button: 0 });
    fireEvent.mouseDown(target, { button: 0 });
    fireEvent.pointerUp(target, { button: 0 });
    fireEvent.click(target);
    expect(onClose).toHaveBeenCalled();
    expect(outside).not.toHaveBeenCalled();
    // The next click is the student's again.
    act(() => vi.advanceTimersByTime(1));
    fireEvent.click(target);
    expect(outside).toHaveBeenCalledOnce();
  });
});
