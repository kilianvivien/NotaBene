import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recorder } from '@/lib/adapters';
import { runAppCommand } from '@/lib/commands';
import { createNote } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { useRecordingStore } from '@/lib/state/recordingStore';
import { useDictationStore } from '@/lib/state/dictationStore';
import i18n from '@/lib/i18n';
import { RecordButton } from './RecordingControls';

vi.mock('@/lib/commands', () => ({ runAppCommand: vi.fn(async () => {}) }));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(recorder, 'supported').mockReturnValue(true);
  await i18n.changeLanguage('en');
  useRecordingStore.setState({ status: 'idle' });
  useDictationStore.setState({ status: 'idle', startedAt: null });
  useLibraryAccessStore.setState({ status: null });
  useEditorStore.setState({ note: createNote({ title: 'Lecture' }) });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('microphone click and hold', () => {
  it('keeps a normal click as audio recording, without starting anything on press', () => {
    render(<RecordButton />);
    const mic = screen.getByRole('button');
    fireEvent.pointerDown(mic, { button: 0 });
    expect(runAppCommand).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(4999));
    fireEvent.pointerUp(mic);
    fireEvent.click(mic);
    expect(runAppCommand).toHaveBeenCalledExactlyOnceWith('recording.toggle');
  });

  it('shows the hold explanation, starts dictation at five seconds, and swallows the release click', () => {
    render(<RecordButton />);
    const mic = screen.getByRole('button');
    fireEvent.pointerDown(mic, { button: 0 });
    expect(screen.getByText(/live dictation in 5 s/)).toBeTruthy();
    expect(screen.getByText(/sends microphone audio to Mistral/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(5000));
    expect(runAppCommand).toHaveBeenCalledExactlyOnceWith('recording.dictation');
    act(() => useDictationStore.setState({ status: 'listening', startedAt: Date.now() }));
    fireEvent.pointerUp(mic);
    fireEvent.click(mic);
    expect(runAppCommand).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(mic, { button: 0 });
    fireEvent.pointerUp(mic);
    fireEvent.click(mic);
    expect(runAppCommand).toHaveBeenCalledTimes(2);
    expect(runAppCommand).toHaveBeenLastCalledWith('recording.dictation');
  });

  it('cancels the pending hold on pointer cancellation and unmount', () => {
    const view = render(<RecordButton />);
    const mic = screen.getByRole('button');
    fireEvent.pointerDown(mic, { button: 0 });
    fireEvent.pointerCancel(mic);
    fireEvent.click(mic);
    act(() => vi.advanceTimersByTime(6000));
    expect(runAppCommand).not.toHaveBeenCalled();
    fireEvent.pointerDown(mic, { button: 0 });
    view.unmount();
    act(() => vi.advanceTimersByTime(6000));
    expect(runAppCommand).not.toHaveBeenCalled();
  });

  it('cancels a hold when the note changes or the window loses focus', () => {
    render(<RecordButton />);
    const mic = screen.getByRole('button');
    fireEvent.pointerDown(mic, { button: 0 });
    act(() => useEditorStore.setState({ note: createNote({ title: 'Another note' }) }));
    act(() => vi.advanceTimersByTime(6000));
    fireEvent.pointerUp(mic);
    fireEvent.click(mic);
    expect(runAppCommand).not.toHaveBeenCalled();
    fireEvent.pointerDown(mic, { button: 0 });
    fireEvent(window, new Event('blur'));
    act(() => vi.advanceTimersByTime(6000));
    fireEvent.pointerUp(mic);
    fireEvent.click(mic);
    expect(runAppCommand).not.toHaveBeenCalled();
  });
});
