/** AI planning documents only. Stored maps and drawings keep their existing
 * contracts, including larger maps the student has edited by hand. */
import { z } from 'zod';
import { DIAGRAM_KINDS } from './schema';

const label = z.string().trim().min(1).max(60);
const editorial = {
  title: z.string().trim().min(1).max(120),
  focus: z.string().trim().min(1).max(240),
  takeaway: z.string().trim().min(1).max(360),
  rationale: z.string().trim().min(1).max(360),
  omitted: z.array(z.string().trim().min(1).max(160)).max(4),
};

export const VisualizationEditorialSchema = z.object(editorial);
export type VisualizationEditorial = z.infer<typeof VisualizationEditorialSchema>;

const concept = z
  .object({
    label,
    note: z.string().trim().max(240).optional(),
  })
  .strict();

export const AiMindMapPlanSchema = z
  .object({
    ...editorial,
    root: label,
    branches: z
      .array(concept.extend({ children: z.array(concept).max(3) }))
      .min(1)
      .max(5),
  })
  .superRefine((plan, context) => {
    const count =
      1 + plan.branches.reduce((n, branch) => n + 1 + branch.children.length, 0);
    if (count > 18) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Select at most 18 nodes including the root; merge or omit secondary details',
        path: ['branches'],
      });
    }
    const labels = [
      plan.root,
      ...plan.branches.flatMap((branch) => [
        branch.label,
        ...branch.children.map((child) => child.label),
      ]),
    ];
    const normalized = labels.map((value) => value.toLocaleLowerCase());
    if (new Set(normalized).size !== labels.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each concept must appear once; merge duplicate concepts',
        path: ['branches'],
      });
    }
  });
export type AiMindMapPlan = z.infer<typeof AiMindMapPlanSchema>;

export const AiDiagramPlanSchema = z
  .object({
    ...editorial,
    kind: z.enum(DIAGRAM_KINDS),
    direction: z.enum(['LR', 'TB']),
    nodes: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(40),
          label,
          shape: z.enum(['box', 'decision']),
        }),
      )
      .min(2)
      .max(18),
    edges: z
      .array(
        z.object({
          from: z.string().trim().min(1).max(40),
          to: z.string().trim().min(1).max(40),
          label: z.string().trim().min(1).max(80),
        }),
      )
      .min(1)
      .max(24),
  })
  .superRefine((plan, context) => {
    const ids = new Set(plan.nodes.map((node) => node.id));
    if (ids.size !== plan.nodes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Node ids must be unique',
        path: ['nodes'],
      });
    }
    if (plan.kind === 'sequence' && plan.nodes.length > 6) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use at most six sequence participants',
        path: ['nodes'],
      });
    }
    for (const [index, edge] of plan.edges.entries()) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Every relation must reference listed nodes',
          path: ['edges', index],
        });
      }
    }
    // Convergence and feedback are valid; disconnected decorative boxes are not.
    const reached = new Set([plan.nodes[0]!.id]);
    for (let pass = 0; pass < plan.nodes.length; pass += 1) {
      for (const edge of plan.edges) {
        if (reached.has(edge.from)) reached.add(edge.to);
        if (reached.has(edge.to)) reached.add(edge.from);
      }
    }
    if (plan.nodes.some((node) => !reached.has(node.id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Connect all nodes to the chosen explanation; omit unrelated material',
        path: ['nodes'],
      });
    }
  });
export type AiDiagramPlan = z.infer<typeof AiDiagramPlanSchema>;
