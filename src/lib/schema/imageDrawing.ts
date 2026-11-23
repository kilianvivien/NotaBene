import { z } from 'zod';

const coordinate = z.number().finite().min(-4_000).max(4_000);
const dimension = z.number().finite().positive().max(4_000);
const color = z.string().regex(/^(#[0-9a-fA-F]{6}|transparent)$/);
const base = z.object({
  x: coordinate,
  y: coordinate,
  strokeColor: color.default('#1e1e1e'),
  strokeWidth: z.number().min(0).max(8).default(1),
  opacity: z.number().min(1).max(100).default(100),
  angle: z
    .number()
    .finite()
    .min(-Math.PI * 2)
    .max(Math.PI * 2)
    .default(0),
});
/** A dashed rule drawn as one element, not as a run of short segments the
 * model has to place one by one. */
const strokeStyle = z.enum(['solid', 'dashed', 'dotted']).default('solid');
const shape = base.extend({
  type: z.enum(['rectangle', 'ellipse', 'diamond']),
  width: dimension,
  height: dimension,
  backgroundColor: color.default('transparent'),
  strokeStyle,
});
const text = base.extend({
  type: z.literal('text'),
  text: z.string().trim().min(1).max(2_000),
  // Clamped, not refused: a 7 pt caption is not worth a second multi-minute
  // repair call. Only presentation depends on it.
  fontSize: z
    .number()
    .finite()
    .transform((size) => Math.min(100, Math.max(8, size)))
    .default(20),
  textAlign: z.enum(['left', 'center', 'right']).default('left'),
});
const line = base.extend({
  type: z.enum(['line', 'arrow']),
  strokeStyle,
  /** Fills a closed line — a block arrow or chevron drawn as one polygon. */
  backgroundColor: color.default('transparent'),
  /** Arrowheads at either end; an arrow defaults to one at its end. */
  startArrowhead: z.enum(['arrow', 'triangle']).nullable().optional(),
  endArrowhead: z.enum(['arrow', 'triangle']).nullable().optional(),
  points: z
    .array(z.tuple([coordinate, coordinate]))
    .min(2)
    .max(30)
    .refine(
      (points) => points[0]?.[0] === 0 && points[0]?.[1] === 0,
      'the first point must be [0,0]',
    )
    .refine(
      (points) => points.some(([x, y]) => x !== 0 || y !== 0),
      'a line must have a non-zero length',
    ),
});

/** A bounded drawing vocabulary, never arbitrary Excalidraw JSON, SVG or images. */
export const ImageDrawingPlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  warnings: z.array(z.string().trim().min(1).max(400)).max(12).default([]),
  elements: z
    .array(z.union([shape, text, line]))
    .min(1)
    .max(200),
});
export type ImageDrawingPlan = z.infer<typeof ImageDrawingPlanSchema>;
