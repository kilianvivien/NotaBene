/**
 * A lecture recording, or any audio attachment, becomes a transcript (plan
 * §10.3).
 *
 * One pipeline for every engine, the way `synthesizePodcastCommand` drives
 * any speech engine a segment at a time: prepare the audio in Rust, settle
 * the language, transcribe window by window, stitch, group into paragraphs,
 * write. Progress is per window on every engine, and a cancel lands within
 * one — the Apple helper is killed mid-window, a hosted call is aborted.
 *
 * The transcript is a note whose paragraphs carry the same `audioAnchor` the
 * student's own blocks do, so the lecture player and its markers work on it
 * with nothing new. No `SCHEMA_VERSION` bump: the note, the anchors and the
 * attachment are all things the library already holds.
 *
 * Never a fallback. The engine is the one the student chose; if it cannot
 * run, the job says why and stops — a local failure is not a reason to send
 * the lecture anywhere.
 */
import {
  asr,
  asrRegistry,
  library,
  type AsrEngine,
  type AsrLanguage,
} from '@/lib/adapters';
import { APPLE_LOCALES } from '@/lib/adapters';
import { attachmentPreviewKind } from '@/lib/attachments/previewSupport';
import i18n from '@/lib/i18n';
import { newId, type Attachment, type DocNode, type Note } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useRecordingStore } from '@/lib/state/recordingStore';
import { stitchWindows, type WindowTranscript } from '@/lib/transcript/stitch';
import { groupParagraphs } from '@/lib/transcript/paragraphs';
import { transcriptBlocks } from '@/lib/transcript/document';
import { formatOffset } from '@/lib/recording/anchors';
import { copyAttachmentCommand } from './assetCommands';
import { createNoteCommand, updateNoteCommand } from './noteCommands';
import { ensureTagCommand } from './organizationCommands';
import { fail, ok, type CommandResult } from './types';

const AI = { source: 'ai' } as const;
const LANGUAGES: AsrLanguage[] = ['fr', 'en'];

export type TranscriptionDestination = 'new-note' | 'append';

export interface TranscribeInput {
  /** The note the audio is attached to. */
  noteId: string;
  attachmentId: string;
  engineId: Parameters<typeof asrRegistry.get>[0];
  language: 'auto' | AsrLanguage;
  destination: TranscriptionDestination;
  useCourseVocabulary: boolean;
}

export type TranscriptionStage = 'preparing' | 'language' | 'transcribing' | 'writing';

export interface TranscribeOptions {
  signal?: AbortSignal;
  onProgress?(progress: {
    stage: TranscriptionStage;
    done: number;
    total: number;
    language?: AsrLanguage | null;
  }): void;
}

export interface TranscriptionOutcome {
  /** Where the transcript is: the new note, or the lecture note itself. */
  noteId: string;
  /** Highlighted runs of doubtful words. */
  passages: number;
  language: string | null;
  durationMs: number;
}

/** `ASR_LANGUAGE_NOT_INSTALLED: fr-FR` → the code the dialog translates. */
export function asrCode(message: string): string | null {
  return /^(ASR_[A-Z_]+)\b/.exec(message)?.[1] ?? null;
}

/** A failure that carries its `ASR_*` code and, for a window, where in the
 * lecture it happened. The dialog words it; the message stays as a fallback. */
function asrFailure<T>(
  error: unknown,
  signal: AbortSignal | undefined,
  window?: { startMs: number; endMs: number },
): CommandResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return fail('cancelled', 'cancelled');
  }
  return fail('storage_failed', message, { asrCode: asrCode(message), window });
}

export function isAudioAttachment(attachment: Pick<Attachment, 'name'>): boolean {
  return attachmentPreviewKind(attachment.name, '') === 'audio';
}

/** The languages the engine can use now, in order of preference. */
async function usableLanguages(engine: AsrEngine): Promise<AsrLanguage[]> {
  if (engine.id !== 'apple-speech') return LANGUAGES;
  const status = await asr.appleStatus(
    LANGUAGES.map((language) => APPLE_LOCALES[language]),
  );
  return LANGUAGES.filter((language) =>
    status.languages.some(
      (entry) => entry.locale === APPLE_LOCALES[language] && entry.status === 'installed',
    ),
  );
}

async function vocabulary(
  note: Note,
  engine: AsrEngine,
  wanted: boolean,
): Promise<string[]> {
  const capabilities = engine.capabilities();
  if (!wanted || !capabilities.vocabulary || !note.courseId) return [];
  // Only what the student accepted. A rejected term is on the list precisely
  // so that it is never offered — or sent — again.
  const terms = await library.listCourseTerms(note.courseId).catch(() => []);
  return terms
    .filter((term) => term.status === 'accepted')
    .map((term) => term.term)
    .slice(0, capabilities.maxVocabularyTerms);
}

function heading(text: string): DocNode {
  return { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] };
}

function t(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options);
}

export async function transcribeAttachmentCommand(
  input: TranscribeInput,
  options: TranscribeOptions = {},
): Promise<CommandResult<TranscriptionOutcome>> {
  const { signal, onProgress } = options;
  // Both want the machine, and a recording's file is still being written.
  if (useRecordingStore.getState().status !== 'idle') {
    return fail('conflict', 'ASR_RECORDING_BUSY', { asrCode: 'ASR_RECORDING_BUSY' });
  }
  await useEditorStore.getState().flush();
  const note = await library.getNote(input.noteId);
  if (!note) return fail('not_found', `no note ${input.noteId}`);
  const attachment = (await library.listAttachments(note.id)).find(
    (candidate) => candidate.id === input.attachmentId,
  );
  if (!attachment || !isAudioAttachment(attachment)) {
    return fail('not_found', 'ASR_AUDIO_MISSING', { asrCode: 'ASR_AUDIO_MISSING' });
  }

  let engine: AsrEngine;
  try {
    engine = await asrRegistry.resolveConfiguredEngine(input.engineId);
  } catch (error) {
    return asrFailure(error, signal);
  }
  const capabilities = engine.capabilities();

  // The language before the audio: a missing model is known in a moment,
  // and should not cost the student a minute of decoding first.
  let language: AsrLanguage | null = null;
  let candidates: AsrLanguage[] = [];
  if (capabilities.languageHint) {
    try {
      const usable = await usableLanguages(engine);
      candidates = input.language === 'auto' ? usable : [input.language];
      if (input.language !== 'auto' && !usable.includes(input.language)) {
        return fail('not_supported', 'ASR_LANGUAGE_NOT_INSTALLED', {
          asrCode: 'ASR_LANGUAGE_NOT_INSTALLED',
          language: input.language,
        });
      }
      if (!candidates.length) {
        return fail('not_supported', 'ASR_LANGUAGE_NOT_INSTALLED', {
          asrCode: 'ASR_LANGUAGE_NOT_INSTALLED',
        });
      }
    } catch (error) {
      return asrFailure(error, signal);
    }
    if (candidates.length === 1) language = candidates[0]!;
  }
  const terms = await vocabulary(note, engine, input.useCourseVocabulary);

  const jobId = newId();
  try {
    onProgress?.({ stage: 'preparing', done: 0, total: 1 });
    let job;
    try {
      job = await asr.prepare({
        jobId,
        assetId: attachment.assetId,
        windowSeconds: capabilities.window.seconds,
        overlapSeconds: capabilities.window.overlapSeconds,
      });
    } catch (error) {
      return asrFailure(error, signal);
    }
    if (signal?.aborted) return fail('cancelled', 'cancelled');

    if (capabilities.languageHint && !language) {
      onProgress?.({ stage: 'language', done: 0, total: 1 });
      try {
        language = engine.detectLanguage
          ? await engine.detectLanguage(job, candidates, signal)
          : candidates[0]!;
      } catch (error) {
        return asrFailure(error, signal);
      }
    }

    const results: WindowTranscript[] = [];
    let detected: string | null = language;
    const total = job.windows.length;
    onProgress?.({ stage: 'transcribing', done: 0, total, language });
    for (const window of job.windows) {
      if (signal?.aborted) return fail('cancelled', 'cancelled');
      let result;
      // One retry: a hosted call can fail for a reason that is gone a second
      // later, and ninety minutes should not be lost to one window's hiccup.
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await engine.transcribeWindow(job, window, {
            language,
            vocabulary: terms,
            signal,
          });
          break;
        } catch (error) {
          if (signal?.aborted || attempt >= 1) {
            return asrFailure(error, signal, {
              startMs: window.startMs,
              endMs: window.endMs,
            });
          }
        }
      }
      detected ??= result.language;
      results.push({ window, segments: result.segments });
      onProgress?.({ stage: 'transcribing', done: window.index + 1, total, language });
    }

    const paragraphs = groupParagraphs(stitchWindows(results));
    if (!paragraphs.length) {
      return fail('not_found', 'ASR_NO_SPEECH', { asrCode: 'ASR_NO_SPEECH' });
    }
    if (signal?.aborted) return fail('cancelled', 'cancelled');
    onProgress?.({ stage: 'writing', done: 0, total: 1, language });

    const written = await writeTranscript(
      note,
      attachment,
      paragraphs,
      input.destination,
      {
        durationMs: job.durationMs,
        language: detected,
        engine,
      },
    );
    if (!written.ok) return written;
    return ok({
      noteId: written.value.noteId,
      passages: written.value.passages,
      language: detected,
      durationMs: job.durationMs,
    });
  } finally {
    await asr.release(jobId).catch(() => undefined);
  }
}

/** A one-line account of where the text came from, at the top. */
function provenance(
  note: Note,
  meta: { durationMs: number; language: string | null; engine: AsrEngine },
  linkBack: boolean,
): DocNode {
  const language = meta.language?.slice(0, 2);
  const details = [
    formatOffset(meta.durationMs),
    language === 'fr' || language === 'en'
      ? t(`transcription.language.${language}`)
      : null,
    t(`transcription.engineName.${meta.engine.id}`),
  ]
    .filter(Boolean)
    .join(' · ');
  const content: DocNode[] = linkBack
    ? [
        { type: 'text', text: `${t('transcription.provenanceOf')} ` },
        { type: 'wikiLink', attrs: { title: note.title || 'Untitled', noteId: note.id } },
        { type: 'text', text: ` — ${details}` },
      ]
    : [{ type: 'text', text: details }];
  return { type: 'paragraph', content };
}

async function writeTranscript(
  note: Note,
  attachment: Attachment,
  paragraphs: ReturnType<typeof groupParagraphs>,
  destination: TranscriptionDestination,
  meta: { durationMs: number; language: string | null; engine: AsrEngine },
): Promise<CommandResult<{ noteId: string; passages: number }>> {
  if (destination === 'append') {
    // The recording is already on this note: anchor to it as it is.
    const { blocks, passages } = transcriptBlocks(paragraphs, attachment.id);
    const current = await library.getNote(note.id);
    if (!current) return fail('not_found', `no note ${note.id}`);
    const updated = await updateNoteCommand(
      {
        noteId: note.id,
        doc: {
          ...current.doc,
          content: [
            ...current.doc.content,
            heading(t('transcription.heading')),
            provenance(note, meta, false),
            ...blocks,
          ],
        },
      },
      AI,
    );
    if (!updated.ok) return updated;
    await useEditorStore.getState().openNote(note.id);
    return ok({ noteId: note.id, passages });
  }

  // The player draws markers only for recordings on the open note, so the
  // transcript gets its own attachment row for the same bytes — and its
  // anchors must name *that* row, minted before the note exists (plan T12).
  const copyId = newId();
  const { blocks, passages } = transcriptBlocks(paragraphs, copyId);
  const tag = await ensureTagCommand({ name: 'transcript', namespace: 'type' }, AI);
  const created = await createNoteCommand(
    {
      title: t('transcription.noteTitle', {
        title: note.title || t('noteList.untitled'),
      }),
      courseId: note.courseId,
      sectionId: note.sectionId,
      tagIds: tag.ok ? [tag.value.id] : [],
      doc: { type: 'doc', content: [provenance(note, meta, true), ...blocks] },
    },
    AI,
  );
  if (!created.ok) return created;
  const copied = await copyAttachmentCommand(attachment, created.value.id, copyId);
  if (!copied.ok) return copied;
  await useLibraryStore.getState().refreshTags();
  return ok({ noteId: created.value.id, passages });
}

/**
 * The transcript of the lecture a note's recording belongs to, if one exists:
 * a note that links here and holds the same audio (plan T12 — matched by
 * asset, since the transcript's copy has its own attachment id).
 */
export async function findTranscriptCommand(
  noteId: string,
  assetId: string,
): Promise<{ noteId: string; attachmentId: string } | null> {
  const backlinks = await library.listBacklinks(noteId).catch(() => []);
  for (const link of backlinks) {
    const attachments = await library.listAttachments(link.sourceId).catch(() => []);
    const match = attachments.find((attachment) => attachment.assetId === assetId);
    if (match) return { noteId: link.sourceId, attachmentId: match.id };
  }
  return null;
}
