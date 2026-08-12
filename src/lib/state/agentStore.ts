/**
 * Recent in-app agent runs.
 *
 * The durable note contents remain in snapshot history. This small journal
 * keeps the plan, calls and snapshot ids that make those versions reviewable
 * and undoable as one run. It contains no provider secrets or full note bodies.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  AgentRunRecordSchema,
  PersistedAgentRunsSchema,
  type AgentRunRecord,
} from '@/lib/schema';

const STORAGE_KEY = 'notabene.agent-runs.v1';
const MAX_RUNS = 20;

interface AgentState {
  runs: AgentRunRecord[];
  activeRunId: string | null;
  putRun(run: AgentRunRecord): void;
  setActiveRun(runId: string | null): void;
}

function loadRuns(): AgentRunRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = PersistedAgentRunsSchema.safeParse(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'),
    );
    return parsed.success ? parsed.data.runs : [];
  } catch {
    return [];
  }
}

function persist(runs: AgentRunRecord[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, runs: runs.slice(0, MAX_RUNS) }),
    );
  } catch {
    // A full or unavailable webview store must not turn a successful library
    // edit into a failure. Snapshot history still retains every note version.
  }
}

export const useAgentStore = create<AgentState>()(
  immer((set, get) => ({
    runs: loadRuns(),
    activeRunId: null,

    putRun(run) {
      const parsed = AgentRunRecordSchema.parse(run);
      set((state) => {
        state.runs = [
          parsed,
          ...state.runs.filter((entry) => entry.id !== parsed.id),
        ].slice(0, MAX_RUNS);
      });
      persist(get().runs);
    },

    setActiveRun(runId) {
      set((state) => {
        state.activeRunId = runId;
      });
    },
  })),
);
