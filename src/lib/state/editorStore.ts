/**
 * The open note and its save lifecycle.
 *
 * "Never lose a keystroke" (PRD §3, goal 3) is implemented here and nowhere
 * else. Three timers run against every edit:
 *
 *   - a journal write, so at most `JOURNAL_MS` of typing is unrecorded;
 *   - a debounce, so a pause of `AUTOSAVE_IDLE_MS` flushes to disk;
 *   - a ceiling, so continuous typing still flushes every `AUTOSAVE_MAX_MS`.
 *
 * The journal is the one that makes the guarantee cheap. A full save is a
 * transaction, a snapshot check, and a list refresh, so it cannot run on every
 * keystroke; a journal write is one upsert into a single-row-per-note table, so
 * it can. What survives a force quit is therefore not the last save — it is the
 * last quarter-second.
 *
 * A fourth cadence takes version snapshots. Save state is exposed so the status
 * bar can show it — a student who sees "Saved" never goes looking for Cmd-S.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { library } from '@/lib/adapters';
import { flattenDoc } from '@/lib/notes/docText';
import { useLibraryStore } from './libraryStore';
import type { Note, NoteDoc } from '@/lib/schema';
import {
  keepEditorVersionCommand,
  saveEditorNoteCommand,
} from '@/lib/commands/editorCommands';

/** Flush after this long without a keystroke. */
export const AUTOSAVE_IDLE_MS = 800;
/** …and never go longer than this under continuous typing. */
export const AUTOSAVE_MAX_MS = 5_000;
/** Crash-journal cadence. Short enough that a force quit costs a few words,
 * long enough that a fast typist is not one IPC call per character. */
export const JOURNAL_MS = 250;
/** Time-based version snapshot cadence during active editing. */
export const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface EditorState {
  note: Note | null;
  saveState: SaveState;
  lastSavedAt: string | null;
  lastSnapshotAt: number | null;
  error: string | null;
  conflict: { mine: Note; theirs: Note } | null;

  openNote(noteId: string): Promise<void>;
  closeNote(): Promise<void>;
  /** Called by the editor on every transaction. Cheap: it only marks dirty and
   * arms the timers. */
  applyDoc(doc: NoteDoc): void;
  setTitle(title: string): void;
  /** Force a write now — window blur, app quit, before an AI action. */
  flush(): Promise<void>;
  resolveConflict(choice: 'mine' | 'theirs'): Promise<void>;
}

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
let journalTimer: ReturnType<typeof setTimeout> | null = null;
/** The journal write currently in flight, so a save can wait for it rather
 * than race it and leave a stale row to be offered back at the next launch. */
let journalInFlight: Promise<void> = Promise.resolve();
/** Serializes durable saves. Callers such as `openNote` must be able to wait
 * for the outgoing note even when an autosave was already on the wire. */
let flushInFlight: Promise<void> | null = null;

function clearTimers(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (ceilingTimer) clearTimeout(ceilingTimer);
  if (journalTimer) clearTimeout(journalTimer);
  idleTimer = null;
  ceilingTimer = null;
  journalTimer = null;
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    note: null,
    saveState: 'idle',
    lastSavedAt: null,
    lastSnapshotAt: null,
    error: null,
    conflict: null,

    async openNote(noteId) {
      const started = performance.now();
      // Never lose the outgoing note's edits to a click on another one.
      await get().flush();
      const note = await library.getNote(noteId);
      set((state) => {
        state.note = note;
        state.saveState = 'idle';
        state.error = null;
        state.conflict = null;
        // The first write in this open session snapshots the state the user
        // opened, so history exists immediately rather than after ten minutes.
        state.lastSnapshotAt = null;
      });
      performance.measure('notabene-note-open', {
        start: started,
        end: performance.now(),
        detail: { noteId },
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
      if (flushInFlight) {
        await flushInFlight;
        // An edit may have landed while the previous snapshot was saving.
        // Explicit callers (notably note navigation) must write that newer
        // state too before they are allowed to continue.
        if (get().saveState === 'dirty') await get().flush();
        return;
      }

      const run = async () => {
        clearTimers();
        // Let a journal write that is already on the wire land first: the store
        // retires the row as part of the save, and re-creating it a moment later
        // would look exactly like unsaved work at the next launch.
        await journalInFlight;

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
          const now = Date.now();
          const snapshotCause =
            lastSnapshotAt === null
              ? 'session'
              : now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS
                ? 'auto'
                : null;
          const saved = await saveEditorNoteCommand(
            updated,
            snapshotCause,
            note.updatedAt,
          );
          if (!saved.ok) {
            if (saved.code === 'conflict') {
              const theirs = await library.getNote(updated.id);
              if (theirs) {
                set((state) => {
                  if (state.note?.id !== updated.id) return;
                  state.conflict = { mine: updated, theirs };
                  state.saveState = 'error';
                  state.error = saved.message;
                });
                return;
              }
            }
            throw new Error(saved.message);
          }
          if (snapshotCause) {
            set((state) => {
              if (state.note?.id === updated.id) state.lastSnapshotAt = now;
            });
          }

          set((state) => {
            if (state.note?.id !== updated.id) return;
            state.note.updatedAt = updated.updatedAt;
            state.note.plainText = updated.plainText;
            if (state.saveState === 'saving') state.saveState = 'saved';
            state.lastSavedAt = updated.updatedAt;
            state.error = null;
          });

          // The list renders titles and snippets from summaries, so it goes
          // stale the moment a save lands unless it is told to re-read.
          await useLibraryStore.getState().refreshCurrentView();
        } catch (error) {
          set((state) => {
            if (state.note?.id !== note.id) return;
            state.saveState = 'error';
            state.error = error instanceof Error ? error.message : String(error);
          });
        }
      };

      flushInFlight = run();
      try {
        await flushInFlight;
      } finally {
        flushInFlight = null;
      }
    },

    async resolveConflict(choice) {
      const conflict = get().conflict;
      if (!conflict) return;
      if (choice === 'theirs') {
        set((state) => {
          state.note = conflict.theirs;
          state.saveState = 'saved';
          state.lastSavedAt = conflict.theirs.updatedAt;
          state.error = null;
          state.conflict = null;
        });
        return;
      }
      const result = await keepEditorVersionCommand(conflict.mine);
      if (!result.ok) throw new Error(result.message);
      set((state) => {
        state.note = result.value;
        state.saveState = 'saved';
        state.lastSavedAt = result.value.updatedAt;
        state.error = null;
        state.conflict = null;
      });
      await useLibraryStore.getState().refreshCurrentView();
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

  if (journalTimer) clearTimeout(journalTimer);
  journalTimer = setTimeout(writeJournal, JOURNAL_MS);
}

/**
 * Record in-flight state ahead of the save. A failure here is swallowed on
 * purpose: the journal is a safety net under autosave, and an app that
 * interrupted someone's typing to report that its safety net hiccuped would be
 * trading a real problem for a hypothetical one. A journal that stops working
 * shows up as `saveState`, which is the signal that actually matters.
 */
function writeJournal(): void {
  journalTimer = null;
  const { note, saveState } = useEditorStore.getState();
  if (!note || saveState !== 'dirty') return;

  journalInFlight = library
    .writeJournal({
      noteId: note.id,
      doc: note.doc,
      title: note.title,
      // Same clock and same format as `note.updatedAt`, which is what the
      // "is this row newer than its note?" comparison rests on.
      writtenAt: new Date().toISOString(),
    })
    .catch(() => {});
}
