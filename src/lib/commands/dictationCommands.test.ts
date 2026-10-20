import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictation, library, recorder, secrets } from '@/lib/adapters';
import type { DictationRequest } from '@/lib/adapters/asr/DictationAdapter';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import {
  registerDictationWriterFactory,
  type DictationWriter,
} from '@/editor/commandBridge';
import { useEditorStore } from '@/lib/state/editorStore';
import { useDictationStore } from '@/lib/state/dictationStore';
import { useRecordingStore } from '@/lib/state/recordingStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { startRecordingCommand } from './recordingCommands';
import { startDictationCommand } from './dictationCommands';

let unregister: () => void;
let request: DictationRequest;
let writer: DictationWriter;
let noteId: string;
const stopAudio = vi.fn(async () => {
  request.onText(' final words.');
});
beforeEach(async () => {
  vi.restoreAllMocks();
  stopAudio.mockClear();
  memoryLibraryAdapter.reset();
  useRecordingStore.setState({ status: 'idle' });
  useLibraryAccessStore.setState({ status: null });
  const note = memoryLibraryAdapter.seedNote({ title: 'Lecture' });
  noteId = note.id;
  useEditorStore.setState({ note, saveState: 'saved' });
  writer = { noteId, append: vi.fn(() => true), close: vi.fn() };
  unregister = registerDictationWriterFactory((id) => (id === noteId ? writer : null));
  await secrets.set('ai.mistral.apiKey', 'test-key');
  vi.spyOn(dictation, 'supported').mockReturnValue(true);
  vi.spyOn(dictation, 'start').mockImplementation(async (input) => {
    request = input;
    return { stop: stopAudio, cancel: vi.fn() };
  });
});
afterEach(async () => {
  if (useDictationStore.getState().status !== 'idle')
    await useDictationStore.getState().stop();
  unregister();
  await secrets.remove('ai.mistral.apiKey');
  vi.restoreAllMocks();
});

describe('direct dictation lifecycle', () => {
  it('inserts live and final text directly with no recording or attachment', async () => {
    const record = vi.spyOn(recorder, 'start');
    await useDictationStore.getState().start(noteId);
    expect(useDictationStore.getState().status).toBe('listening');
    request.onText('Spoken text');
    await useDictationStore.getState().stop();
    expect(writer.append).toHaveBeenNthCalledWith(1, 'Spoken text');
    expect(writer.append).toHaveBeenNthCalledWith(2, ' final words.');
    expect(writer.close).toHaveBeenCalledOnce();
    expect(await library.listAttachments(noteId)).toEqual([]);
    expect(record).not.toHaveBeenCalled();
    expect(useDictationStore.getState().status).toBe('idle');
  });

  it('drains the original note before navigation and rejects subsequent text', async () => {
    await useDictationStore.getState().start(noteId);
    const next = memoryLibraryAdapter.seedNote({ title: 'Next' });
    await useEditorStore.getState().openNote(next.id);
    expect(writer.append).toHaveBeenCalledWith(' final words.');
    expect(useEditorStore.getState().note?.id).toBe(next.id);
    expect(() => request.onText('wrong note')).toThrow('DICTATION_TARGET');
    expect(writer.append).toHaveBeenCalledTimes(1);
  });

  it('refuses missing keys, read-only access and an existing recording before opening audio', async () => {
    await secrets.remove('ai.mistral.apiKey');
    const input = {
      noteId,
      signal: new AbortController().signal,
      onLevel() {},
      onFailure() {},
    };
    expect((await startDictationCommand(input)).ok).toBe(false);
    await secrets.set('ai.mistral.apiKey', 'test-key');
    useLibraryAccessStore.setState({
      status: { libraryDir: '/test', readOnly: true, lockOwner: null },
    });
    expect((await startDictationCommand(input)).ok).toBe(false);
    useLibraryAccessStore.setState({ status: null });
    useRecordingStore.setState({ status: 'recording' });
    expect((await startDictationCommand(input)).ok).toBe(false);
    expect(dictation.start).not.toHaveBeenCalled();
  });

  it('blocks a simultaneous normal recording and closes on provider failure', async () => {
    await useDictationStore.getState().start(noteId);
    vi.spyOn(recorder, 'supported').mockReturnValue(true);
    const recording = vi.spyOn(recorder, 'start');
    expect((await startRecordingCommand({ noteId })).ok).toBe(false);
    expect(recording).not.toHaveBeenCalled();
    request.onFailure(new Error('provider gone'));
    await vi.waitFor(() => expect(useDictationStore.getState().status).toBe('idle'));
    expect(request.signal.aborted).toBe(true);
    expect(writer.close).toHaveBeenCalled();
  });
});
