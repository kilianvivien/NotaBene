import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asr,
  asrRegistry,
  library,
  type AsrEngine,
  type AsrEngineCapabilities,
  type AsrJob,
} from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { parseAudioAnchor } from '@/lib/recording/anchors';
import type { Attachment, DocNode } from '@/lib/schema';
import { useRecordingStore } from '@/lib/state/recordingStore';
import {
  asrCode,
  findTranscriptCommand,
  transcribeAttachmentCommand,
  type TranscribeInput,
} from './transcriptionCommands';

const JOB: AsrJob = {
  jobId: 'job',
  durationMs: 1_203_000,
  windows: [
    { index: 0, startMs: 0, endMs: 603_000 },
    { index: 1, startMs: 600_000, endMs: 1_203_000 },
  ],
};

const HOSTED: AsrEngineCapabilities = {
  local: false,
  window: { seconds: 600, overlapSeconds: 3 },
  wordTimestamps: false,
  confidences: false,
  languageHint: false,
  vocabulary: 'context-bias',
  maxVocabularyTerms: 100,
  provider: 'mistral',
};

function fakeEngine(
  transcribe: AsrEngine['transcribeWindow'],
  capabilities: AsrEngineCapabilities = HOSTED,
): AsrEngine {
  return {
    id: 'mistral-api',
    capabilities: () => capabilities,
    status: async () => ({ kind: 'ready' }),
    transcribeWindow: transcribe,
  };
}

const sentence = (text: string, start: number) => ({
  segments: [{ start, end: start + 4, text, words: [] }],
  language: 'fr',
});

async function lecture(): Promise<{ input: TranscribeInput; attachment: Attachment }> {
  const note = memoryLibraryAdapter.seedNote({ title: 'Cours 4' });
  const attachment: Attachment = {
    id: 'rec-1',
    noteId: note.id,
    assetId: 'a'.repeat(64),
    name: 'Cours.m4a',
    createdAt: '2026-09-28T08:00:00.000Z',
    annotations: [],
    url: null,
    fetchedAt: null,
  };
  await library.upsertAttachment(attachment);
  return {
    attachment,
    input: {
      noteId: note.id,
      attachmentId: attachment.id,
      engineId: 'mistral-api',
      language: 'auto',
      destination: 'new-note',
      useCourseVocabulary: true,
    },
  };
}

function anchors(content: DocNode[]) {
  return content
    .map((node) => parseAudioAnchor(node.attrs?.audioAnchor))
    .filter((anchor) => anchor !== null);
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  vi.restoreAllMocks();
  useRecordingStore.setState({ status: 'idle' });
  vi.spyOn(asr, 'prepare').mockResolvedValue(JOB);
  vi.spyOn(asr, 'release').mockResolvedValue();
});

describe('transcribeAttachmentCommand', () => {
  it('writes a transcript note whose paragraphs play the copy of the recording', async () => {
    const { input, attachment } = await lecture();
    const engine = fakeEngine(async (_job, window) =>
      window.index === 0
        ? sentence('Bonjour à tous.', 10)
        : sentence('Fin du cours.', 100),
    );
    vi.spyOn(asrRegistry, 'resolveConfiguredEngine').mockResolvedValue(engine);
    const progress: number[] = [];

    const result = await transcribeAttachmentCommand(input, {
      onProgress: ({ stage, done }) => {
        if (stage === 'transcribing') progress.push(done);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(progress).toEqual([0, 1, 2]);
    const transcript = await library.getNote(result.value.noteId);
    expect(transcript?.title).toContain('Cours 4');
    const [copy] = await library.listAttachments(result.value.noteId);
    expect(copy?.assetId).toBe(attachment.assetId);
    // The copy has its own id, and the anchors name it (plan T12).
    expect(copy?.id).not.toBe(attachment.id);
    expect(anchors(transcript!.doc.content)).toEqual([
      { recordingId: copy!.id, offsetMs: 10_000 },
      { recordingId: copy!.id, offsetMs: 700_000 },
    ]);
    expect(asr.release).toHaveBeenCalledWith(expect.any(String));
    // Found again from the lecture note by the shared audio.
    expect(await findTranscriptCommand(input.noteId, attachment.assetId)).toEqual({
      noteId: result.value.noteId,
      attachmentId: copy!.id,
    });
  });

  it('appends under a heading, anchored to the recording already there', async () => {
    const { input } = await lecture();
    vi.spyOn(asrRegistry, 'resolveConfiguredEngine').mockResolvedValue(
      fakeEngine(async () => sentence('Bonjour.', 1)),
    );

    const result = await transcribeAttachmentCommand({ ...input, destination: 'append' });

    expect(result.ok && result.value.noteId).toBe(input.noteId);
    const note = await library.getNote(input.noteId);
    expect(note!.doc.content.some((node) => node.type === 'heading')).toBe(true);
    expect(anchors(note!.doc.content)[0]?.recordingId).toBe('rec-1');
  });

  it('retries a failed window once, then fails naming where in the lecture', async () => {
    const { input } = await lecture();
    const transcribe = vi.fn(async (_job: AsrJob, window: { index: number }) => {
      if (window.index === 1) throw new Error('ASR_API_ERROR: 503 overloaded');
      return sentence('Bonjour.', 1);
    });
    vi.spyOn(asrRegistry, 'resolveConfiguredEngine').mockResolvedValue(
      fakeEngine(transcribe),
    );

    const result = await transcribeAttachmentCommand(input);

    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details).toMatchObject({
      asrCode: 'ASR_API_ERROR',
      window: { startMs: 600_000, endMs: 1_203_000 },
    });
    expect(asr.release).toHaveBeenCalled();
    // Nothing written for a failed job.
    expect((await library.queryNotes({ scope: 'live' })).length).toBe(1);
  });

  it('stops between windows on cancel and writes nothing', async () => {
    const { input } = await lecture();
    const controller = new AbortController();
    vi.spyOn(asrRegistry, 'resolveConfiguredEngine').mockResolvedValue(
      fakeEngine(async () => {
        controller.abort();
        return sentence('Bonjour.', 1);
      }),
    );

    const result = await transcribeAttachmentCommand(input, {
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cancelled');
    expect((await library.queryNotes({ scope: 'live' })).length).toBe(1);
    expect(asr.release).toHaveBeenCalled();
  });

  it('refuses while a lecture is being recorded', async () => {
    const { input } = await lecture();
    useRecordingStore.setState({ status: 'recording' });
    const result = await transcribeAttachmentCommand(input);
    expect(result.ok).toBe(false);
    expect(asr.prepare).not.toHaveBeenCalled();
  });

  it('never swaps in another engine when the chosen one cannot run', async () => {
    const { input } = await lecture();
    vi.spyOn(asrRegistry, 'resolveConfiguredEngine').mockRejectedValue(
      new Error('ASR_API_KEY_MISSING: connect Mistral AI first'),
    );
    const result = await transcribeAttachmentCommand(input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.details).toMatchObject({ asrCode: 'ASR_API_KEY_MISSING' });
    expect(asr.prepare).not.toHaveBeenCalled();
  });

  it('asks the on-device engine for the language when there is a choice', async () => {
    const { input } = await lecture();
    const detect = vi.fn(async () => 'en' as const);
    const seen: (string | null)[] = [];
    const engine: AsrEngine = {
      ...fakeEngine(
        async (_job, _window, options) => {
          seen.push(options.language);
          return sentence('Hello.', 1);
        },
        { ...HOSTED, local: true, languageHint: true, provider: null },
      ),
      id: 'apple-speech',
      detectLanguage: detect,
    };
    vi.spyOn(asrRegistry, 'resolveConfiguredEngine').mockResolvedValue(engine);
    vi.spyOn(asr, 'appleStatus').mockResolvedValue({
      available: true,
      languages: [
        { locale: 'fr-FR', status: 'installed' },
        { locale: 'en-US', status: 'installed' },
      ],
    });

    const result = await transcribeAttachmentCommand({
      ...input,
      engineId: 'apple-speech',
    });

    expect(result.ok).toBe(true);
    expect(detect).toHaveBeenCalledWith(JOB, ['fr', 'en'], undefined);
    expect(seen).toEqual(['en', 'en']);
  });

  it('says a language is not installed before decoding anything', async () => {
    const { input } = await lecture();
    vi.spyOn(asrRegistry, 'resolveConfiguredEngine').mockResolvedValue({
      ...fakeEngine(async () => sentence('x', 0), { ...HOSTED, languageHint: true }),
      id: 'apple-speech',
    });
    vi.spyOn(asr, 'appleStatus').mockResolvedValue({
      available: true,
      languages: [{ locale: 'fr-FR', status: 'supported' }],
    });
    const result = await transcribeAttachmentCommand({
      ...input,
      engineId: 'apple-speech',
      language: 'fr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.details).toMatchObject({ asrCode: 'ASR_LANGUAGE_NOT_INSTALLED' });
    expect(asr.prepare).not.toHaveBeenCalled();
  });
});

describe('the lecture vocabulary', () => {
  it('is sent as hints and respells what the engine was unsure of', async () => {
    const { input } = await lecture();
    const note = (await library.getNote(input.noteId))!;
    const typed = 'Les réactions ont lieu dans les thylakoïdes du chloroplaste.';
    await library.upsertNote({
      ...note,
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: typed }] }],
      },
      plainText: typed,
    });
    const hints: string[][] = [];
    vi.spyOn(asrRegistry, 'resolveConfiguredEngine').mockResolvedValue(
      fakeEngine(async (_job, _window, options) => {
        hints.push(options.vocabulary);
        return {
          language: 'fr',
          segments: [
            {
              start: 1,
              end: 3,
              text: 'dans les thyloïdes.',
              words: [
                { text: 'dans', start: 1, end: 1.3, confidence: 0.98 },
                { text: 'les', start: 1.3, end: 1.5, confidence: 0.97 },
                { text: 'thyloïdes.', start: 1.5, end: 2.2, confidence: 0.31 },
              ],
            },
          ],
        };
      }),
    );

    const result = await transcribeAttachmentCommand({ ...input, destination: 'append' });

    expect(hints[0]).toContain('thylakoïdes');
    expect(result.ok && result.value.corrected).toBe(2);
    const text = (await library.getNote(input.noteId))!.plainText;
    expect(text).toContain('les thylakoïdes.');
    expect(text).not.toContain('thyloïdes');
  });

  it('is not used when the student turned course vocabulary off', async () => {
    const { input } = await lecture();
    const hints: string[][] = [];
    vi.spyOn(asrRegistry, 'resolveConfiguredEngine').mockResolvedValue(
      fakeEngine(async (_job, _window, options) => {
        hints.push(options.vocabulary);
        return sentence('Bonjour.', 1);
      }),
    );
    await transcribeAttachmentCommand({ ...input, useCourseVocabulary: false });
    expect(hints.every((list) => list.length === 0)).toBe(true);
  });
});

describe('asrCode', () => {
  it('reads the code a failure starts with', () => {
    expect(asrCode('ASR_APPLE_LANGUAGE_NOT_INSTALLED: fr-FR')).toBe(
      'ASR_APPLE_LANGUAGE_NOT_INSTALLED',
    );
    expect(asrCode('network down')).toBeNull();
  });
});
