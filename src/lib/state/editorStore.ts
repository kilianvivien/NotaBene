/**
 * The open note and its save lifecycle.
 *
 * "Never lose a keystroke" (PRD §3, goal 3) is implemented here and nowhere
 * else. Two timers run against every edit:
 *
 *   - a debounce, so a pause of `AUTOSAVE_IDLE_MS` flushes to disk;
 *   - a ceiling, so continuous typing still flushes every `AUTOSAVE_MAX_MS`.
 *
 * A third cadence takes version snapshots. Save state is exposed so the status
 * bar can show it — a student who sees "Saved" never goes looking for Cmd-S.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { library } from '@/lib/adapters';
import { flattenDoc } from '@/lib/notes/docText';
import { useLibraryStore } from './libraryStore';
import type { Note, NoteDoc } from '@/lib/schema';

/** Flush after this long without a keystroke. */
export const AUTOSAVE_IDLE_MS = 800;
/** …and never go longer than this under continuous typing. */
export const AUTOSAVE_MAX_MS = 5_000;
/** Time-based version snapshot cadence during active editing. */
export const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface EditorState {
  note: Note | null;
  saveState: SaveState;
  lastSavedAt: string | null;
  lastSnapshotAt: number | null;
  error: string | null;

  openNote(noteId: string): Promise<void>;
  closeNote(): Promise<void>;
  /** Called by the editor on every transaction. Cheap: it only marks dirty and
   * arms the timers. */
  applyDoc(doc: NoteDoc): void;
  setTitle(title: string): void;
  /** Force a write now — window blur, app quit, before an AI action. */
  flush(): Promise<void>;
}

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let ceilingTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (ceilingTimer) clearTimeout(ceilingTimer);
  idleTimer = null;
  ceilingTimer = null;
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    note: null,
    saveState: 'idle',
    lastSavedAt: null,
    lastSnapshotAt: null,
    error: null,

    async openNote(noteId) {
      // Never lose the outgoing note's edits to a click on another one.
      await get().flush();
      const note = await library.getNote(noteId);
      set((state) => {
        state.note = note;
        state.saveState = 'idle';
        state.error = null;
        state.lastSnapshotAt = note ? Date.now() : null;
      });
    },

    async closeNote() {
      await get().flush();
      clearTimers();
      set((state) => {
        state.note = null;
        state.saveState = 'idle';
      });
    },

    applyDoc(doc) {
      set((state) => {
        if (!state.note) return;
        state.note.doc = doc;
        state.saveState = 'dirty';
      });
      scheduleFlush();
    },

    setTitle(title) {
      set((state) => {
        if (!state.note) return;
        state.note.title = title;
        state.saveState = 'dirty';
      });
      scheduleFlush();
    },

    async flush() {
      clearTimers();
      const { note, saveState, lastSnapshotAt } = get();
      if (!note || saveState !== 'dirty') return;

      set((state) => {
        state.saveState = 'saving';
      });
      try {
        const updated: Note = {
          ...note,
          plainText: flattenDoc(note.doc),
          updatedAt: new Date().toISOString(),
        };
        await library.upsertNote(updated);

        // Time-based snapshots ride along with a save so the snapshot always
        // matches something that actually reached disk.
        const now = Date.now();
        if (lastSnapshotAt === null || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
          await library.createSnapshot(note.id, 'auto');
          set((state) => {
            state.lastSnapshotAt = now;
          });
        }

        set((state) => {
          state.note = updated;
          state.saveState = 'saved';
          state.lastSavedAt = updated.updatedAt;
          state.error = null;
        });

        // The list renders titles and snippets from summaries, so it goes
        // stale the moment a save lands unless it is told to re-read.
        await useLibraryStore.getState().refreshCurrentView();
      } catch (error) {
        set((state) => {
          state.saveState = 'error';
          state.error = error instanceof Error ? error.message : String(error);
        });
      }
    },
  })),
);

function scheduleFlush(): void {
  const flush = () => void useEditorStore.getState().flush();

  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(flush, AUTOSAVE_IDLE_MS);

  // Only arm the ceiling once per dirty streak — re-arming it on every
  // keystroke would make it a second debounce and it would never fire.
  if (!ceilingTimer) {
    ceilingTimer = setTimeout(flush, AUTOSAVE_MAX_MS);
  }
}
