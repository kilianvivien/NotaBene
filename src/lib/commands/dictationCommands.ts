import { dictation, library, secrets } from '@/lib/adapters';
import { secretKeyFor } from '@/lib/ai/providers';
import { dictationWriterAtCaret, type DictationWriter } from '@/editor/commandBridge';
import type { DictationSession } from '@/lib/adapters/asr/DictationAdapter';
import { RecorderUnavailableError } from '@/lib/adapters/recorder/RecorderAdapter';
import { DictationTextSchema } from '@/lib/schema/dictation';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { useRecordingStore } from '@/lib/state/recordingStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { hintTerms, lectureVocabulary } from '@/lib/transcript/vocabulary';
import { loadCourseVocabulary } from '@/lib/vocabulary';
import i18n from '@/lib/i18n';
import { fail, ok, type CommandResult } from './types';

export interface ActiveDictationSession {
  audio: DictationSession;
  writer: DictationWriter;
}

export function appendDictationTextCommand(
  writer: DictationWriter,
  text: unknown,
): boolean {
  const parsed = DictationTextSchema.safeParse(text);
  return (
    parsed.success &&
    !useLibraryAccessStore.getState().status?.readOnly &&
    useEditorStore.getState().note?.id === writer.noteId &&
    writer.append(parsed.data)
  );
}

export async function startDictationCommand(input: {
  noteId: string;
  signal: AbortSignal;
  onLevel(level: number): void;
  onFailure(error: unknown): void;
}): Promise<CommandResult<ActiveDictationSession>> {
  if (useRecordingStore.getState().status !== 'idle')
    return fail('conflict', i18n.t('dictation.busy'));
  if (!dictation.supported())
    return fail('not_supported', i18n.t('dictation.unsupported'));
  if (useLibraryAccessStore.getState().status?.readOnly)
    return fail('storage_failed', i18n.t('recording.readOnly'));
  let writer: DictationWriter | null = null;
  try {
    const key = await secrets.get(secretKeyFor('mistral'));
    if (!key) return fail('not_supported', i18n.t('dictation.keyMissing'));
    await useEditorStore.getState().flush();
    const note = useEditorStore.getState().note;
    if (!note || note.id !== input.noteId)
      return fail('not_found', i18n.t('dictation.noteRequired'));
    const settings = useSettingsStore.getState().settings;
    let vocabulary: string[] = [];
    if (settings.recording.transcription.useCourseVocabulary) {
      const [curated, course] = await Promise.all([
        note.courseId ? library.listCourseTerms(note.courseId).catch(() => []) : [],
        note.courseId ? loadCourseVocabulary(note.courseId).catch(() => null) : null,
      ]);
      vocabulary = hintTerms(
        lectureVocabulary({ curated, note, harvested: course?.harvested ?? [] }),
        100,
      ).filter((term) => term.length <= 250);
    }
    if (input.signal.aborted) return fail('cancelled', 'cancelled');
    writer = dictationWriterAtCaret(input.noteId);
    if (!writer) return fail('not_supported', i18n.t('dictation.noteRequired'));
    const target = writer;
    const audio = await dictation.start({
      apiKey: key,
      input: settings.recording,
      vocabulary,
      signal: input.signal,
      onLevel: input.onLevel,
      onFailure: input.onFailure,
      onText: (text) => {
        if (!appendDictationTextCommand(target, text))
          throw new Error('DICTATION_TARGET');
      },
    });
    return ok({ audio, writer });
  } catch (error) {
    writer?.close();
    if (input.signal.aborted) return fail('cancelled', 'cancelled');
    return fail(
      'storage_failed',
      error instanceof RecorderUnavailableError
        ? i18n.t(`recording.unavailable.${error.reason}`)
        : i18n.t('dictation.failed'),
    );
  }
}

export async function stopDictationCommand(
  session: ActiveDictationSession,
): Promise<CommandResult<void>> {
  try {
    await session.audio.stop();
    return ok(undefined);
  } catch {
    return fail('storage_failed', i18n.t('dictation.failed'));
  } finally {
    session.writer.close();
    await useEditorStore.getState().flush();
  }
}
