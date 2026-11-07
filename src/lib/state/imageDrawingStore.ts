/**
 * Image → drawing reconstructions in flight, drawn inline on the image itself.
 *
 * Not `aiStore.running`: that slot is one-at-a-time and every AI dialog greys
 * out while it is taken. A reconstruction runs in the background while the
 * student keeps typing, possibly for several images at once, so each job has
 * its own state here and its own controller in the command layer.
 *
 * Nothing is persisted. A job is a request, not library data; the drawing it
 * produces is an ordinary editor node from the moment it lands.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { CommandResult } from '@/lib/commands/types';
import type { ImageDrawingTarget } from '@/lib/notes/imageTargets';

export type ImageDrawingJobStatus = 'running' | 'done' | 'failed';

export interface ImageDrawingJob {
  id: string;
  target: ImageDrawingTarget;
  status: ImageDrawingJobStatus;
  /** Kept whole so the surface translates it (`aiErrorMessage`). */
  failure?: Extract<CommandResult<unknown>, { ok: false }>;
  warnings: string[];
}

interface ImageDrawingState {
  jobs: Record<string, ImageDrawingJob>;
  put(job: ImageDrawingJob): void;
  patch(id: string, patch: Partial<Omit<ImageDrawingJob, 'id'>>): void;
  remove(id: string): void;
}

export const useImageDrawingStore = create<ImageDrawingState>()(
  immer((set) => ({
    jobs: {},
    put(job) {
      set((state) => {
        state.jobs[job.id] = job;
      });
    },
    patch(id, patch) {
      set((state) => {
        const job = state.jobs[id];
        if (job) Object.assign(job, patch);
      });
    },
    remove(id) {
      set((state) => {
        delete state.jobs[id];
      });
    },
  })),
);
