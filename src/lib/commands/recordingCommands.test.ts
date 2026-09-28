import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  library,
  recorder,
  RecorderUnavailableError,
  type RecorderSession,
} from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import type { Asset } from '@/lib/schema';
import {
  discardInterruptedRecordingCommand,
  keepRecordingCommand,
  recordingFileName,
  recoverRecordingCommand,
  startRecordingCommand,
} from './recordingCommands';

const ASSET: Asset = {
  id: 'a'.repeat(64),
  mime: 'audio/mp4',
  bytes: 43_000_000,
  createdAt: '2026-09-28T10:00:00.000Z',
};

function session(overrides: Partial<RecorderSession> = {}): RecorderSession {
  return {
    id: 'rec-1',
    mime: 'audio/mp4',
    startedAt: Date.parse('2026-09-28T08:15:00Z'),
    stop: vi.fn(async () => ASSET),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  vi.restoreAllMocks();
  useLibraryAccessStore.setState({ status: null });
});

describe('recordingFileName', () => {
  it('names the file after when it was recorded, with an audio extension', () => {
    const name = recordingFileName(new Date('2026-09-28T08:15:00Z'), 'audio/mp4');
    expect(name).toMatch(/\.m4a$/);
    // A colon becomes a slash in Finder, where a saved copy ends up.
    expect(name).not.toContain(':');
    expect(recordingFileName(new Date(), 'audio/webm;codecs=opus')).toMatch(/\.webm$/);
  });
});

describe('startRecordingCommand', () => {
  it('fails loudly where recording is impossible, rather than doing nothing', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });
    // The test shell is the browser shell: the unavailable adapter.
    const result = await startRecordingCommand({ noteId: note.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_supported');
  });

  it('refuses on a read-only library before the microphone is touched', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });
    vi.spyOn(recorder, 'supported').mockReturnValue(true);
    const start = vi.spyOn(recorder, 'start');
    useLibraryAccessStore.setState({
      status: { libraryDir: '/x', readOnly: true, lockOwner: null },
    });

    const result = await startRecordingCommand({ noteId: note.id });

    expect(result.ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('says why when the microphone is refused', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });
    vi.spyOn(recorder, 'supported').mockReturnValue(true);
    vi.spyOn(recorder, 'start').mockRejectedValue(new RecorderUnavailableError('denied'));

    const result = await startRecordingCommand({ noteId: note.id });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/microphone|micro/i);
  });

  it('mints the id the attachment and every anchor will share', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });
    vi.spyOn(recorder, 'supported').mockReturnValue(true);
    const start = vi
      .spyOn(recorder, 'start')
      .mockImplementation(async (request) => session({ id: request.id }));

    const result = await startRecordingCommand({ noteId: note.id });

    expect(result.ok).toBe(true);
    expect(start.mock.calls[0]![0].noteId).toBe(note.id);
    if (result.ok) expect(result.value.id).toBe(start.mock.calls[0]![0].id);
  });
});

describe('keepRecordingCommand', () => {
  it('turns the recording into an attachment whose id is the recording id', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });

    const result = await keepRecordingCommand(session(), note.id);

    expect(result.ok).toBe(true);
    const attachments = await library.listAttachments(note.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ id: 'rec-1', assetId: ASSET.id });
    expect(attachments[0]!.name).toMatch(/\.m4a$/);
  });

  it('writes no attachment when the audio could not be moved into the store', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });

    const result = await keepRecordingCommand(
      session({ stop: vi.fn(async () => Promise.reject(new Error('disk full'))) }),
      note.id,
    );

    expect(result.ok).toBe(false);
    expect(await library.listAttachments(note.id)).toHaveLength(0);
  });
});

describe('recovering an interrupted recording', () => {
  const interrupted = (noteId: string) => ({
    id: 'rec-2',
    noteId,
    mime: 'audio/mp4',
    startedAt: '2026-09-28T08:15:00Z',
    bytes: 1_000,
  });

  it('attaches it to the note it was started in', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });
    const recover = vi.spyOn(recorder, 'recover').mockResolvedValue(ASSET);

    const result = await recoverRecordingCommand(interrupted(note.id));

    expect(result.ok).toBe(true);
    expect(recover).toHaveBeenCalledWith('rec-2');
    expect((await library.listAttachments(note.id))[0]?.id).toBe('rec-2');
  });

  it('keeps the file, untouched, when its note is gone', async () => {
    const recover = vi.spyOn(recorder, 'recover');

    const result = await recoverRecordingCommand(interrupted('missing-note'));

    expect(result.ok).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it('discards only when asked', async () => {
    const discard = vi.spyOn(recorder, 'discard').mockResolvedValue();
    const result = await discardInterruptedRecordingCommand('rec-2');
    expect(result.ok).toBe(true);
    expect(discard).toHaveBeenCalledWith('rec-2');
  });
});
