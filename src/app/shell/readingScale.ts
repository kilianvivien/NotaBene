/**
 * The bounds of the reading scale.
 *
 * Shared by the on-page reading controls and the Editor settings pane so the
 * two cannot disagree about what is a legal size — a stepper that stops at 22
 * beside a slider that goes to 24 is a bug waiting to be filed.
 */
export const EDITOR_FONT_SIZES = { min: 13, max: 22 };

/** Column width in rem. The floor is about 45 characters and the ceiling about
 * 110 — narrow enough for a phone-shaped column on a wide display, wide enough
 * for someone who wants the window filled, and neither extreme is a measure
 * anyone reads comfortably by accident. */
export const EDITOR_MEASURES = { min: 28, max: 64 };

/** One press of the width stepper, in rem. Fine enough to land where you want,
 * coarse enough that getting there is a few presses and not twenty. */
export const MEASURE_STEP = 2;
