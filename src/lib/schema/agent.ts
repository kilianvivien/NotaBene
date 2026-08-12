import { z } from 'zod';
import { CourseSchema, SectionSchema, TagSchema } from './schema';

/** Exactly the MCP surface. The in-app agent imports this list rather than
 * growing a private capability that external agents do not have. */
export const AGENT_TOOL_NAMES = [
  'get_app_state',
  'list_courses',
  'list_notes',
  'search_notes',
  'read_note',
  'create_note',
  'update_note',
  'manage_tags',
  'create_course',
  'export_notes',
  'organize',
] as const;
export const AgentToolNameSchema = z.enum(AGENT_TOOL_NAMES);
export type AgentToolName = z.infer<typeof AgentToolNameSchema>;

const AgentPlanStepSchema = z.object({
  description: z.string().trim().min(1).max(500),
  expectedTools: z.array(AgentToolNameSchema).max(AGENT_TOOL_NAMES.length),
  /** Machine references stay separate from the sentence shown to the student. */
  noteIds: z.array(z.string().min(1)).max(500).default([]),
});

/** Shape requested from the model. Titles are resolved from the library after
 * parsing rather than trusted to a generated plan. */
const AgentPlanDraftBaseSchema = z.object({
  summary: z.string().trim().min(1).max(1_000),
  steps: z.array(AgentPlanStepSchema).min(1).max(16),
});
const executablePlan = (plan: z.infer<typeof AgentPlanDraftBaseSchema>) =>
  plan.steps.some((step) => step.expectedTools.length > 0);
export const AgentPlanDraftSchema = AgentPlanDraftBaseSchema.refine(executablePlan, {
  message: 'an executable plan must name at least one expected tool',
});
export type AgentPlanDraft = z.infer<typeof AgentPlanDraftSchema>;

export const AgentPlanSchema = AgentPlanDraftBaseSchema.extend({
  /** Trusted id/title pairs captured when the plan was made. The UI resolves
   * `noteIds` through this table and never prints an internal id. */
  noteReferences: z
    .array(
      z.object({
        noteId: z.string().min(1),
        title: z.string(),
      }),
    )
    .max(500)
    .default([]),
});
export type AgentPlan = z.infer<typeof AgentPlanSchema>;

export const AgentDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('tool'),
    tool: AgentToolNameSchema,
    arguments: z.record(z.unknown()).default({}),
    rationale: z.string().trim().min(1).max(1_000),
  }),
  z.object({
    action: z.literal('done'),
    /** Explicit self-check against the original instruction. The command layer
     * also verifies that every operation promised by the plan succeeded. */
    outcomeAchieved: z.boolean(),
    summary: z.string().trim().min(1).max(2_000),
  }),
]);
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export const AgentScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selection'), noteIds: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('course'), courseId: z.string().min(1) }),
  z.object({ kind: z.literal('library') }),
]);
export type AgentScope = z.infer<typeof AgentScopeSchema>;

export const AgentBudgetSchema = z.object({
  tokenCeiling: z.number().int().positive(),
  toolCallCeiling: z.number().int().positive(),
  wallClockMs: z.number().int().positive(),
});
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

export const AgentToolCallRecordSchema = z.object({
  id: z.string().min(1),
  tool: AgentToolNameSchema,
  arguments: z.record(z.unknown()),
  rationale: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  resultPreview: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type AgentToolCallRecord = z.infer<typeof AgentToolCallRecordSchema>;

export const AgentTouchedNoteSchema = z.object({
  noteId: z.string().min(1),
  title: z.string(),
  snapshotId: z.string().nullable(),
  created: z.boolean(),
});
export type AgentTouchedNote = z.infer<typeof AgentTouchedNoteSchema>;

export const AgentUndoJournalSchema = z.object({
  notesBefore: z.array(
    z.object({
      noteId: z.string().min(1),
      courseId: z.string().nullable(),
      sectionId: z.string().nullable(),
      tagIds: z.array(z.string()),
      pinned: z.boolean(),
      archived: z.boolean(),
    }),
  ),
  createdNoteIds: z.array(z.string()),
  createdCourses: z.array(CourseSchema),
  createdSections: z.array(SectionSchema),
  createdTagIds: z.array(z.string()),
  tagsBeforeRename: z.array(TagSchema),
});
export type AgentUndoJournal = z.infer<typeof AgentUndoJournalSchema>;

export const AgentRunRecordSchema = z.object({
  id: z.string().min(1),
  /** Follow-ups are separate undo units, but remain linked to the run whose
   * result the student is refining. Optional keeps existing v1 journals valid. */
  parentRunId: z.string().min(1).optional(),
  instruction: z.string().min(1),
  scope: AgentScopeSchema,
  plan: AgentPlanSchema,
  budget: AgentBudgetSchema,
  status: z.enum(['planned', 'running', 'completed', 'failed', 'cancelled', 'undone']),
  calls: z.array(AgentToolCallRecordSchema),
  touchedNotes: z.array(AgentTouchedNoteSchema),
  undoJournal: AgentUndoJournalSchema,
  tokensUsed: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  summary: z.string().optional(),
  error: z.string().optional(),
});
export type AgentRunRecord = z.infer<typeof AgentRunRecordSchema>;

export const PersistedAgentRunsSchema = z.object({
  version: z.literal(1),
  runs: z.array(AgentRunRecordSchema).max(20),
});
