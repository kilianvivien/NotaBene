import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commands from '@/lib/commands';
import type { AgentRunRecord } from '@/lib/schema';
import { useAgentStore } from '@/lib/state/agentStore';
import { useAiStore } from '@/lib/state/aiStore';
import { AgentPanel } from './AgentPanel';

vi.mock('./useAiAvailability', () => ({
  useAiAvailability: () => ({
    available: true,
    definition: { id: 'test', label: 'Test provider' },
    baseUrl: 'https://example.test',
    model: 'test-model',
  }),
  isLocalAvailability: () => false,
}));

function plannedRun(): AgentRunRecord {
  return {
    id: 'agent-panel-run',
    instruction: 'Organize the course.',
    scope: { kind: 'course', courseId: 'course-1' },
    plan: {
      summary: 'Review and organize the current course',
      noteReferences: [],
      steps: [
        {
          description: 'Read the course notes before making changes.',
          expectedTools: ['list_notes', 'read_note'],
          noteIds: [],
        },
      ],
    },
    budget: { tokenCeiling: 200_000, toolCallCeiling: 32, wallClockMs: 600_000 },
    status: 'planned',
    calls: [],
    touchedNotes: [],
    undoJournal: {
      notesBefore: [],
      createdNoteIds: [],
      createdCourses: [],
      createdSections: [],
      createdTagIds: [],
      tagsBeforeRename: [],
    },
    tokensUsed: 0,
    startedAt: null,
    completedAt: null,
  };
}

beforeEach(() => {
  const run = plannedRun();
  useAgentStore.setState({ runs: [run], activeRunId: run.id });
  useAiStore.setState({ agentMode: true, askScope: 'note', running: null });
});

afterEach(() => {
  cleanup();
  useAgentStore.setState({ runs: [], activeRunId: null });
  useAiStore.setState({ agentMode: false, running: null });
  vi.restoreAllMocks();
});

describe('AgentPanel review gate', () => {
  it('shows the plan, its steps in words, and the limits before execution', () => {
    render(<AgentPanel noteId="note-1" />);

    expect(screen.getByText('Review and organize the current course')).not.toBeNull();
    expect(
      screen.getByText(/Read the course notes before making changes\./),
    ).not.toBeNull();
    // Tool names appear as the labels Settings already uses, never as
    // `list_notes`.
    expect(screen.getByText('List notes · Read note')).not.toBeNull();
    expect(screen.queryByText(/list_notes/)).toBeNull();
    // The ceilings are still on screen before the button that starts the run —
    // as a sentence, and without the word "token".
    expect(
      screen.getByText(
        'Works only on this course. Stops by itself after 32 steps or 10 min.',
      ),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Run it' })).not.toHaveProperty(
      'disabled',
      true,
    );
  });

  it('offers explicit widening when the plan requires the whole library', async () => {
    useAgentStore.setState({ runs: [], activeRunId: null });
    useAiStore.setState({ askScope: 'note', agentMode: true, running: null });
    vi.spyOn(commands, 'planAgentCommand').mockResolvedValue({
      ok: false,
      code: 'scope_denied',
      message: 'This task requires “All notes”.',
      details: { kind: 'scope_required', requiredScope: 'library' },
    });

    render(<AgentPanel noteId="note-1" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent' }), {
      target: { value: 'Create an Environment course' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Plan it' }));

    const widen = await screen.findByRole('button', { name: 'Use All notes' });
    expect(screen.getByRole('alert').textContent).toContain(
      'This task requires “All notes”.',
    );
    fireEvent.click(widen);
    expect(useAiStore.getState().askScope).toBe('library');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows trusted titles and never internal note ids in a plan', () => {
    const active = plannedRun();
    active.plan = {
      summary: 'Read note-1',
      noteReferences: [{ noteId: 'note-1', title: 'Limits' }],
      steps: [
        {
          description: 'Read note-1 before filing it.',
          expectedTools: ['read_note'],
          noteIds: ['note-1'],
        },
      ],
    };
    useAgentStore.setState({ runs: [active], activeRunId: active.id });

    render(<AgentPanel noteId="note-1" />);

    expect(screen.getAllByText(/Limits/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/note-1/)).toBeNull();
  });

  it('describes finished calls without exposing internal fields or raw details', () => {
    const active = plannedRun();
    active.status = 'completed';
    active.summary = 'The course is organized.';
    active.tokensUsed = 4_200;
    active.plan.steps[0]!.description =
      'Read the note and get its updatedAt before changing it.';
    active.calls = [
      {
        id: 'call-1',
        tool: 'search_notes',
        arguments: { query: 'canicule' },
        rationale: 'Find the notes worth merging.',
        status: 'succeeded',
        // Truncated exactly as the run journal stores it: unparseable, which is
        // why the arguments are what the line is built from.
        resultPreview: '[{"id":"71dnBlhpiffq","courseId":null,"title":"Canic…',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        id: 'call-2',
        tool: 'update_note',
        arguments: { noteId: 'note-1' },
        rationale: 'Read its updatedAt before changing it.',
        status: 'succeeded',
        resultPreview: '{"title":"Limits"}',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ];
    active.touchedNotes = [
      { noteId: 'note-1', title: 'Limits', snapshotId: 'snapshot-1', created: false },
    ];
    useAgentStore.setState({ runs: [active], activeRunId: active.id });

    render(<AgentPanel noteId="note-1" />);

    expect(screen.getByText('Searched for “canicule”')).not.toBeNull();
    expect(screen.getByText('Rewrote “Limits”')).not.toBeNull();
    expect(screen.queryByText(/updatedAt/)).toBeNull();
    expect(screen.queryByText(/71dnBlhpiffq/)).toBeNull();
    expect(screen.queryByText('Technical details')).toBeNull();
    expect(screen.getByText('The course is organized.')).not.toBeNull();
    expect(screen.getByTitle('Open the version from before this run')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Undo the changes' })).not.toHaveProperty(
      'disabled',
      true,
    );
  });

  it('plans a follow-up with the finished run as context', async () => {
    const active = plannedRun();
    active.status = 'completed';
    active.summary = 'The course is organized.';
    active.completedAt = new Date().toISOString();
    useAgentStore.setState({ runs: [active], activeRunId: active.id });
    const plan = vi.spyOn(commands, 'planAgentCommand').mockResolvedValue({
      ok: true,
      value: { ...plannedRun(), id: 'follow-up', parentRunId: active.id },
    });

    render(<AgentPanel noteId="note-1" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Follow-up' }), {
      target: { value: 'Make the recap shorter.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Plan the follow-up' }));

    await waitFor(() => expect(plan).toHaveBeenCalledOnce());
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: 'Make the recap shorter.',
        followUpTo: active.id,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not claim note scope when there is no note to scope to', () => {
    // The scope control is shared with Ask, which cannot open without a note.
    // The agent can: ⌘⌥A works from an empty editor, and the executor would
    // widen "this note" to the whole library without saying so.
    useAgentStore.setState({ runs: [], activeRunId: null });
    useAiStore.setState({ askScope: 'note' });

    render(<AgentPanel noteId={null} />);

    expect(screen.getByTitle('Scope · All notes')).not.toBeNull();
    expect(screen.queryByTitle('Scope · This note')).toBeNull();
  });

  it('leaves a running agent running when the panel goes away', () => {
    const active = plannedRun();
    active.status = 'running';
    useAgentStore.setState({ runs: [active], activeRunId: active.id });
    useAiStore.setState({ running: 'agent' });

    const view = render(<AgentPanel noteId="note-1" />);
    expect(screen.getByRole('button', { name: /Stop/ })).not.toBeNull();

    // Closing the inspector, opening another note, or switching the Agent
    // switch off must not cancel the run — only the Stop button does.
    view.unmount();
    expect(useAiStore.getState().running).toBe('agent');
  });
});
