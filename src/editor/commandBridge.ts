/**
 * The application menu lives outside the TipTap React tree. This tiny bridge
 * lets menu and toolbar actions reach the mounted editor without putting an
 * Editor instance in global state or teaching the command layer about React.
 */
export type EditorCommand =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'highlight'
  | 'code'
  | 'image'
  | 'drawing'
  | 'table'
  | 'callout'
  | 'math'
  | 'footnote'
  | 'endnote'
  | 'link'
  | 'date'
  | 'wikipedia'
  | 'define'
  | 'vocabularyAdd'
  | 'vocabularyIgnore'
  | 'proofread'
  | 'find';

type Runner = (command: EditorCommand) => boolean | Promise<boolean>;

export interface PdfExcerptInput {
  attachmentId: string;
  annotationId: string;
  sourceName: string;
  page: number;
  text: string;
  comment?: string;
}

type PdfExcerptInserter = (input: PdfExcerptInput) => boolean;

let runner: Runner | null = null;
let pdfExcerptInserter: PdfExcerptInserter | null = null;

export function registerEditorCommandRunner(next: Runner): () => void {
  runner = next;
  return () => {
    if (runner === next) runner = null;
  };
}

export async function runEditorCommand(command: EditorCommand): Promise<boolean> {
  return (await runner?.(command)) ?? false;
}

export function registerPdfExcerptInserter(next: PdfExcerptInserter): () => void {
  pdfExcerptInserter = next;
  return () => {
    if (pdfExcerptInserter === next) pdfExcerptInserter = null;
  };
}

export function insertPdfExcerpt(input: PdfExcerptInput): boolean {
  return pdfExcerptInserter?.(input) ?? false;
}

/** The paragraph the caret is in, as the check dialog sends it to a model. */
export interface ParagraphTarget {
  paragraph: string;
  from: number;
  to: number;
}

/** A correction the student kept, with its offset into `ParagraphTarget`. */
export interface AcceptedCorrection {
  index: number;
  original: string;
  replacement: string;
}

/**
 * How the check dialog, which lives with the other AI dialogs outside the
 * editor, reaches the paragraph: it asks which one the caret is in when it
 * opens, and hands corrections back to be applied as one editor transaction —
 * so they autosave, version and undo like anything typed.
 */
export interface ParagraphChecker {
  current(): ParagraphTarget | null;
  /** False when the paragraph changed since it was sent, and nothing was applied. */
  apply(target: ParagraphTarget, corrections: AcceptedCorrection[]): boolean;
}

let paragraphChecker: ParagraphChecker | null = null;

export function registerParagraphChecker(next: ParagraphChecker): () => void {
  paragraphChecker = next;
  return () => {
    if (paragraphChecker === next) paragraphChecker = null;
  };
}

export function paragraphAtCaret(): ParagraphTarget | null {
  return paragraphChecker?.current() ?? null;
}

export function applyParagraphCorrections(
  target: ParagraphTarget,
  corrections: AcceptedCorrection[],
): boolean {
  return paragraphChecker?.apply(target, corrections) ?? false;
}
