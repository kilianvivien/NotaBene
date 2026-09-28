/**
 * Lecture recordings (plan §10.0).
 *
 * A finished recording is an ordinary attachment on the note it was started
 * in — content-addressed, in backups, removable on its own — whose id is the
 * recording's id. That id is what the anchors on the student's blocks carry,
 * so the attachment row is the whole link between the notes and the audio and
 * no new library entity was needed.
 *
 * Nothing here records unasked: `startRecordingCommand` is reachable from an
 * explicit command only, and an interrupted recording is offered back as a
 * file, never resumed.
 */
import i18n from '@/lib/i18n';
import {
  library,
  recorder,
  RecorderUnavailableError,
  type InterruptedRecording,
  type RecorderSession,
} from '@/lib/adapters';
import { AttachmentSchema, newId, type Asset, type Attachment } from '@/lib/schema';
import { attachmentsChanged } from '@/lib/state/attachmentStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { fail, ok, type CommandResult } from './types';

const EXTENSIONS: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
};

/** "Recording — 28 Sept 2026, 10:15.m4a", in the interface language. The
 * extension is what makes the attachment previewable as audio. */
export function recordingFileName(startedAt: Date, mime: string): string {
  const when = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(startedAt);
  const extension = EXTENSIONS[mime.split(';')[0]!.trim()] ?? 'm4a';
  // A colon in a file name becomes a slash in Finder, which is where a saved
  // copy of this attachment ends up.
  return `${i18n.t('recording.fileName', { date: when }).replaceAll(':', '.')}.${extension}`;
}

export interface StartRecordingInput {
  noteId: string;
  onLevel?(level: number): void;
  onFailure?(error: unknown): void;
}

export async function startRecordingCommand(
  input: StartRecordingInput,
): Promise<CommandResult<RecorderSession>> {
  if (!recorder.supported()) {
    return fail('not_supported', i18n.t('recording.unsupported'));
  }
  if (useLibraryAccessStore.getState().status?.readOnly) {
    return fail('storage_failed', i18n.t('recording.readOnly'));
  }
  const note = await library.getNote(input.noteId);
  if (!note) return fail('not_found', `note ${input.noteId} not found`);

  try {
    return ok(
      await recorder.start({
        id: newId(),
        noteId: input.noteId,
        onLevel: input.onLevel,
        onFailure: input.onFailure,
      }),
    );
  } catch (error) {
    if (error instanceof RecorderUnavailableError) {
      return fail(
        error.reason === 'unsupported' ? 'not_supported' : 'storage_failed',
        i18n.t(`recording.unavailable.${error.reason}`),
        error,
      );
    }
    return fail('storage_failed', i18n.t('recording.startFailed'), error);
  }
}

async function attach(
  recordingId: string,
  noteId: string,
  asset: Asset,
  startedAt: Date,
): Promise<CommandResult<Attachment>> {
  const parsed = AttachmentSchema.safeParse({
    id: recordingId,
    noteId,
    assetId: asset.id,
    name: recordingFileName(startedAt, asset.mime),
    createdAt: new Date().toISOString(),
    annotations: [],
  });
  if (!parsed.success) {
    return fail('invalid_input', 'invalid recording attachment', parsed.error.issues);
  }
  try {
    await library.upsertAttachment(parsed.data);
    attachmentsChanged();
    return ok(parsed.data);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

/**
 * Stop and keep. A failure here leaves the audio where it was written, and the
 * next launch offers it back — the one outcome this must never have is a
 * lecture that is neither an attachment nor recoverable.
 */
export async function keepRecordingCommand(
  session: RecorderSession,
  noteId: string,
): Promise<CommandResult<Attachment>> {
  let asset: Asset;
  try {
    asset = await session.stop();
  } catch (error) {
    return fail('storage_failed', i18n.t('recording.saveFailed'), error);
  }
  return attach(session.id, noteId, asset, new Date(session.startedAt));
}

/** Stop and throw away — the student's explicit choice, never a fallback. */
export async function cancelRecordingCommand(
  session: RecorderSession,
): Promise<CommandResult<void>> {
  try {
    await session.cancel();
    return ok(undefined);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

export async function listInterruptedRecordingsCommand(): Promise<
  InterruptedRecording[]
> {
  try {
    return await recorder.interrupted();
  } catch {
    return [];
  }
}

/** Keep a recording the app stopped writing, on the note it was started in. */
export async function recoverRecordingCommand(
  recording: InterruptedRecording,
): Promise<CommandResult<Attachment>> {
  const note = await library.getNote(recording.noteId);
  // Refused rather than attached somewhere else: the offer stays, and a
  // restored backup that brings the note back makes it answerable again.
  if (!note) return fail('not_found', i18n.t('recording.noteMissing'));
  let asset: Asset;
  try {
    asset = await recorder.recover(recording.id);
  } catch (error) {
    return fail('storage_failed', i18n.t('recording.saveFailed'), error);
  }
  return attach(recording.id, recording.noteId, asset, new Date(recording.startedAt));
}

export async function discardInterruptedRecordingCommand(
  recordingId: string,
): Promise<CommandResult<void>> {
  try {
    await recorder.discard(recordingId);
    return ok(undefined);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

export type { InterruptedRecording, RecorderSession };
