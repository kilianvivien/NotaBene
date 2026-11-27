import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { useUiStore } from '@/lib/state/uiStore';
import { SettingsWindow } from './SettingsWindow';

beforeEach(async () => {
  await i18n.changeLanguage('en');
  // jsdom lays nothing out, so it has no scrolling to do.
  Element.prototype.scrollIntoView = vi.fn();
  useUiStore.setState({ settingsOpen: true, settingsTab: 'general' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function searchField() {
  return screen.getByRole('searchbox', { name: 'Search settings' });
}

describe('Settings search', () => {
  it('clears the query on the first Escape and closes on the second', () => {
    render(<SettingsWindow />);
    fireEvent.change(searchField(), { target: { value: 'dictation' } });
    expect(screen.getByRole('button', { name: 'Dictation' })).toBeTruthy();

    fireEvent.keyDown(searchField(), { key: 'Escape' });
    expect((searchField() as HTMLInputElement).value).toBe('');
    expect(useUiStore.getState().settingsOpen).toBe(true);

    fireEvent.keyDown(searchField(), { key: 'Escape' });
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });

  it('opens a folded section it lands on', async () => {
    render(<SettingsWindow />);
    fireEvent.change(searchField(), { target: { value: 'transparency' } });
    fireEvent.click(screen.getByRole('button', { name: 'AI transparency' }));
    expect(useUiStore.getState().settingsTab).toBe('about');
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const disclosure = screen
      .getAllByRole('button', { name: 'AI transparency' })
      .find((button) => button.hasAttribute('aria-expanded'));
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('says so when nothing matches', () => {
    render(<SettingsWindow />);
    fireEvent.change(searchField(), { target: { value: 'zzzz' } });
    expect(screen.getByText('No setting matches “zzzz”.')).toBeTruthy();
  });
});
