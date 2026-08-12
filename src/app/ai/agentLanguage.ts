/**
 * What the agent did, in words a student reads.
 *
 * The run journal is an audit record: it stores the tool name and a JSON
 * preview of what came back, which is the right thing to *keep* and the wrong
 * thing to *show*. `[{"id":"71dnBlhpiffq","courseId":null,…` tells a reader
 * nothing about whether the agent understood them.
 *
 * Everything here is derivation for display only — no new field on
 * `AgentToolCallRecord`, because a persisted schema should not grow to carry a
 * sentence the UI can compute. Two rules make the derivation trustworthy:
 *
 * 1. **Prefer `arguments` over `resultPreview`.** Arguments are stored whole;
 *    the preview is truncated at 500 characters, so `JSON.parse` on a real
 *    `search_notes` result throws more often than not.
 * 2. **Say nothing rather than something wrong.** A call whose outcome cannot
 *    be described returns `null` and the row falls back to the model's own
 *    rationale, which is already on the line above.
 */
import type {
  AgentPlan,
  AgentRunRecord,
  AgentToolCallRecord,
  AgentToolName,
} from '@/lib/schema';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The tool's own name, as the MCP activity list in Settings already says it. */
export function toolLabel(tool: AgentToolName, t: Translate): string {
  return t(`mcp.tool_${tool}`);
}

/** Plan prose is model-authored. Resolve any known id again at display time so
 * old journals and a missed normalization path still cannot expose one. */
export function planText(plan: AgentPlan, value: string): string {
  return plan.noteReferences.reduce(
    (visible, reference) => visible.split(reference.noteId).join(reference.title),
    value,
  );
}

/** If the model kept a note reference properly structured but wrote a generic
 * sentence, show the trusted library title beside it. */
export function planStepTitles(
  plan: AgentPlan,
  step: AgentPlan['steps'][number],
): string[] {
  const description = planText(plan, step.description).toLocaleLowerCase();
  return step.noteIds.flatMap((noteId) => {
    const title = plan.noteReferences.find((entry) => entry.noteId === noteId)?.title;
    return title && !description.includes(title.toLocaleLowerCase()) ? [title] : [];
  });
}

/**
 * One line describing what a finished call actually did, or `null` when the
 * record does not support an honest answer.
 */
export function callOutcome(
  call: AgentToolCallRecord,
  run: AgentRunRecord,
  t: Translate,
): string | null {
  if (call.status !== 'succeeded') return null;
  const args = call.arguments;
  const parsed = parsePreview(call.resultPreview);

  switch (call.tool) {
    case 'get_app_state':
      return t('agent.did_get_app_state');

    case 'list_courses':
      return Array.isArray(parsed)
        ? t('agent.did_list_courses', { count: parsed.length })
        : null;

    case 'list_notes':
    case 'search_notes': {
      if (Array.isArray(parsed)) return t('agent.did_notes', { count: parsed.length });
      const query = typeof args.query === 'string' ? args.query : null;
      return query ? t('agent.did_searched', { query }) : null;
    }

    case 'read_note': {
      const title = previewTitle(parsed) ?? touchedTitle(run, args.noteId);
      return title
        ? t('agent.did_read_note', { title })
        : t('agent.did_read_note_generic');
    }

    case 'create_note': {
      const title =
        previewTitle(parsed) ?? (typeof args.title === 'string' ? args.title : null);
      return title ? t('agent.did_create_note', { title }) : null;
    }

    case 'update_note': {
      const title = touchedTitle(run, args.noteId) ?? previewTitle(parsed);
      return title
        ? t('agent.did_update_note', { title })
        : t('agent.did_update_note_generic');
    }

    case 'manage_tags':
      return t('agent.did_manage_tags');
    case 'create_course':
      return t('agent.did_create_course');
    case 'export_notes':
      return t('agent.did_export_notes');
    case 'organize':
      return t('agent.did_organize');
  }
}

/** The plain sentence that replaces a grid of ceilings: where it may work, and
 * when it gives up. Token ceilings are real but they are not a student's unit —
 * they stay in the technical details. */
export function limitsSentence(run: AgentRunRecord, t: Translate): string {
  return t('agent.limits', {
    scope: scopePhrase(run.scope, t),
    steps: run.budget.toolCallCeiling,
    minutes: Math.max(1, Math.round(run.budget.wallClockMs / 60_000)),
  });
}

/**
 * The scope as it appears *inside* a sentence, which is not the same string as
 * the scope on a menu row. "Bibliothèque" is a fine label and a bad object —
 * French wants "toute la bibliothèque" after a preposition, and English wants
 * the article too.
 */
function scopePhrase(scope: AgentRunRecord['scope'], t: Translate): string {
  if (scope.kind === 'selection')
    return t('agent.limitsScopeSelection', { count: scope.noteIds.length });
  if (scope.kind === 'course') return t('agent.limitsScopeCourse');
  return t('agent.limitsScopeLibrary');
}

function parsePreview(preview: string | undefined): unknown {
  if (!preview) return null;
  try {
    return JSON.parse(preview);
  } catch {
    // Truncated at 500 characters, which is most real results. The caller has
    // a fallback for exactly this.
    return null;
  }
}

function previewTitle(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const title = (parsed as { title?: unknown }).title;
  return typeof title === 'string' && title.trim() ? title : null;
}

/** The run already records the title of every note it wrote to, whole and
 * untruncated — a better source than any preview. */
function touchedTitle(run: AgentRunRecord, noteId: unknown): string | null {
  if (typeof noteId !== 'string') return null;
  const touched = run.touchedNotes.find((entry) => entry.noteId === noteId);
  return touched?.title.trim() ? touched.title : null;
}
