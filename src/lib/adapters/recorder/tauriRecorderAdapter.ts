/** Slices go to `src-tauri/src/recording.rs`, which appends and flushes each
 * one before answering. */
import { invoke } from '@tauri-apps/api/core';
import type { Asset } from '@/lib/schema';
import { encodeBlobBase64 } from '@/lib/archive/base64';
import { createMediaRecorderAdapter, type RecordingSink } from './mediaRecorderAdapter';
import type { InterruptedRecording } from './RecorderAdapter';

const tauriRecordingSink: RecordingSink = {
  begin: (id, noteId, mime) => invoke('recording_begin', { id, noteId, mime }),
  append: async (id, slice) => {
    await invoke('recording_append', { id, data: await encodeBlobBase64(slice) });
  },
  finish: (id) => invoke<Asset>('recording_finish', { id }),
  discard: (id) => invoke('recording_discard', { id }),
  interrupted: () => invoke<InterruptedRecording[]>('recording_interrupted'),
};

export const tauriRecorderAdapter = createMediaRecorderAdapter(tauriRecordingSink);
