import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunRecord } from '@/lib/schema';
import { useAgentStore } from '@/lib/state/agentStore';
import { useUiStore } from '@/lib/state/uiStore';
import { AgentDialog } from './AgentDialog';

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
    id: 'agent-dialog-run',
    instruction: 'Organize the course.',
    scope: { kind: 'course', courseId: 'course-1' },
    plan: {
      summary: 'Review and organize the current course',
      steps: [
        {
          description: 'Read the course notes before making changes.',
          expectedTools: ['list_notes', 'read_note'],
        },
      ],
    },
    budget: { tokenCeiling: 50_000, toolCallCeiling: 24, wallClockMs: 120_000 },
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
  useUiStore.setState({ agentOpen: true });
});

afterEach(() => {
  cleanup();
  useUiStore.getState().setAgentOpen(false);
  useAgentStore.setState({ runs: [], activeRunId: null });
  vi.clearAllMocks();
});

describe('AgentDialog review gate', () => {
  it('shows the plan, scope, and every hard ceiling before execution', () => {
    render(<AgentDialog />);

    expect(screen.getByText('Review and organize the current course')).not.toBeNull();
    expect(
      screen.getByText('Read the course notes before making changes.'),
    ).not.toBeNull();
    expect(screen.getByText('Current course')).not.toBeNull();
    expect(screen.getByText('50,000')).not.toBeNull();
    expect(screen.getByText('24')).not.toBeNull();
    expect(screen.getByText('120 seconds')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Run plan' })).not.toHaveProperty(
      'disabled',
      true,
    );
  });

  it('renders live tool rationale and the touched-note diff link', () => {
    const active = plannedRun();
    active.status = 'completed';
    active.summary = 'The course is organized.';
    active.tokensUsed = 4_200;
    active.calls = [
      {
        id: 'call-1',
        tool: 'update_note',
        arguments: { noteId: 'note-1' },
        rationale: 'Move the note into its matching section.',
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

    render(<AgentDialog />);

    expect(screen.getByText('Move the note into its matching section.')).not.toBeNull();
    expect(screen.getByText('The course is organized.')).not.toBeNull();
    expect(screen.getByTitle('Open the exact before-version')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Undo whole run' })).not.toHaveProperty(
      'disabled',
      true,
    );
  });
});
