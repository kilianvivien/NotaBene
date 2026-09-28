/**
 * Playing a note's lecture audio back (plan §10.0 item 5).
 *
 * The open note's audio attachments, which one is loaded, and where it is. The
 * player docked in the note and the anchor markers beside its blocks both
 * drive this one store, and so do the command-table entries, which is what
 * lets ⌥⌘/ pause whatever the marker started.
 *
 * The `HTMLAudioElement` and its object URL live in module scope, as in
 * `speechStore`: not state React should re-render over. The audio is loaded
 * only when something is first played — a lecture is tens of megabytes, and
 * opening a note must not read it.
 */
import { create } from 'zustand';
import { assets } from '@/lib/adapters';
import type { Attachment } from '@/lib/schema';
import { LEAD_IN_MS, type AudioAnchor } from '@/lib/recording/anchors';

export const SKIP_MS = 10_000;

interface LecturePlaybackState {
  noteId: string | null;
  /** Newest first. */
  recordings: Attachment[];
  currentId: string | null;
  loadedId: string | null;
  loading: boolean;
  playing: boolean;
  positionMs: number;
  /** `null` until known — MediaRecorder output often starts without one. */
  durationMs: number | null;
  error: string;
  /** Called by the player whenever the note or its attachments change. */
  setRecordings(noteId: string, recordings: Attachment[]): void;
  select(recordingId: string): void;
  toggle(): Promise<void>;
  skip(deltaMs: number): Promise<void>;
  seek(positionMs: number): Promise<void>;
  playAnchor(anchor: AudioAnchor): Promise<void>;
  reset(): void;
}

let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;

function release(): void {
  audio?.pause();
  audio?.removeAttribute('src');
  audio?.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  const sync = () =>
    useLecturePlaybackStore.setState({
      positionMs: Math.round((audio?.currentTime ?? 0) * 1000),
      playing: !!audio && !audio.paused && !audio.ended,
    });
  audio.addEventListener('timeupdate', sync);
  audio.addEventListener('play', sync);
  audio.addEventListener('pause', sync);
  audio.addEventListener('ended', sync);
  audio.addEventListener('durationchange', () => {
    const seconds = audio?.duration ?? NaN;
    if (Number.isFinite(seconds)) {
      useLecturePlaybackStore.setState({ durationMs: Math.round(seconds * 1000) });
    }
  });
  return audio;
}

/**
 * A recording written in slices often has no duration in its header, and the
 * element reports `Infinity` until it has seen the end. Seeking far past the
 * end makes WebKit and Chromium both find it; the position is put back after.
 */
async function discoverDuration(media: HTMLAudioElement): Promise<void> {
  if (Number.isFinite(media.duration)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      media.removeEventListener('durationchange', check);
      window.clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (Number.isFinite(media.duration)) done();
    };
    const timer = window.setTimeout(done, 3000);
    media.addEventListener('durationchange', check);
    media.currentTime = 1e7;
  });
  media.currentTime = 0;
}

async function ensureLoaded(recordingId: string): Promise<HTMLAudioElement | null> {
  const state = useLecturePlaybackStore.getState();
  const media = element();
  if (state.loadedId === recordingId && objectUrl) return media;
  const recording = state.recordings.find((candidate) => candidate.id === recordingId);
  if (!recording) return null;

  release();
  useLecturePlaybackStore.setState({
    loading: true,
    loadedId: null,
    durationMs: null,
    positionMs: 0,
    error: '',
  });
  const url = await assets.urlFor(recording.assetId).catch(() => null);
  // The student may have moved to another note while the bytes were read.
  if (useLecturePlaybackStore.getState().currentId !== recordingId) {
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    return null;
  }
  if (!url) {
    useLecturePlaybackStore.setState({ loading: false, error: 'missing' });
    return null;
  }
  objectUrl = url.startsWith('blob:') ? url : null;
  media.src = url;
  await new Promise<void>((resolve) => {
    if (media.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
    media.addEventListener('loadedmetadata', () => resolve(), { once: true });
    media.addEventListener('error', () => resolve(), { once: true });
  });
  if (media.error) {
    useLecturePlaybackStore.setState({ loading: false, error: 'unplayable' });
    return null;
  }
  await discoverDuration(media);
  useLecturePlaybackStore.setState({
    loading: false,
    loadedId: recordingId,
    durationMs: Number.isFinite(media.duration)
      ? Math.round(media.duration * 1000)
      : null,
  });
  return media;
}

const EMPTY = {
  noteId: null,
  recordings: [],
  currentId: null,
  loadedId: null,
  loading: false,
  playing: false,
  positionMs: 0,
  durationMs: null,
  error: '',
};

export const useLecturePlaybackStore = create<LecturePlaybackState>((set, get) => ({
  ...EMPTY,

  setRecordings(noteId, recordings) {
    const state = get();
    if (state.noteId !== noteId) {
      release();
      set({ ...EMPTY, noteId, recordings, currentId: recordings[0]?.id ?? null });
      return;
    }
    const stillThere = recordings.some((recording) => recording.id === state.currentId);
    if (!stillThere) {
      release();
      set({
        ...EMPTY,
        noteId,
        recordings,
        currentId: recordings[0]?.id ?? null,
      });
      return;
    }
    set({ recordings });
  },

  select(recordingId) {
    if (get().currentId === recordingId) return;
    release();
    set({
      currentId: recordingId,
      loadedId: null,
      playing: false,
      positionMs: 0,
      durationMs: null,
      error: '',
    });
  },

  async toggle() {
    const { currentId } = get();
    if (!currentId) return;
    const media = await ensureLoaded(currentId);
    if (!media) return;
    if (media.paused) await media.play().catch(() => set({ error: 'unplayable' }));
    else media.pause();
  },

  async skip(deltaMs) {
    const { currentId } = get();
    if (!currentId) return;
    const media = await ensureLoaded(currentId);
    if (!media) return;
    const limit = Number.isFinite(media.duration) ? media.duration : Infinity;
    media.currentTime = Math.min(limit, Math.max(0, media.currentTime + deltaMs / 1000));
    set({ positionMs: Math.round(media.currentTime * 1000) });
  },

  async seek(positionMs) {
    const { currentId } = get();
    if (!currentId) return;
    const media = await ensureLoaded(currentId);
    if (!media) return;
    media.currentTime = Math.max(0, positionMs / 1000);
    set({ positionMs: Math.round(media.currentTime * 1000) });
  },

  async playAnchor(anchor) {
    if (!get().recordings.some((recording) => recording.id === anchor.recordingId))
      return;
    get().select(anchor.recordingId);
    const media = await ensureLoaded(anchor.recordingId);
    if (!media) return;
    media.currentTime = Math.max(0, (anchor.offsetMs - LEAD_IN_MS) / 1000);
    await media.play().catch(() => set({ error: 'unplayable' }));
  },

  reset() {
    release();
    set(EMPTY);
  },
}));
