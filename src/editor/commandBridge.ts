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
  | 'link'
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
