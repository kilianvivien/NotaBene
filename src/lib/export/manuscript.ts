export interface ManuscriptExportOptions {
  enabled: boolean;
  title: string;
  subtitle: string;
  author: string;
  runningHead: string;
  numberSections: boolean;
  numberFigures: boolean;
}

export const DEFAULT_MANUSCRIPT_OPTIONS: ManuscriptExportOptions = {
  enabled: false,
  title: '',
  subtitle: '',
  author: '',
  runningHead: '',
  numberSections: true,
  numberFigures: true,
};

export interface SectionNumberState {
  chapter: number;
  headings: number[];
  figure: number;
  table: number;
}

export function nextHeadingNumber(state: SectionNumberState, level: number): string {
  const index = Math.min(5, Math.max(0, level - 1));
  state.headings[index] = (state.headings[index] ?? 0) + 1;
  state.headings.splice(index + 1);
  return [
    state.chapter,
    ...state.headings.slice(0, index + 1).filter((part) => part > 0),
  ].join('.');
}

export function manuscriptLabel(
  key: 'contents' | 'footnotes' | 'endnotes' | 'figure' | 'table',
  language?: string,
): string {
  const french = language?.startsWith('fr');
  const labels = french
    ? {
        contents: 'Sommaire',
        footnotes: 'Notes de bas de page',
        endnotes: 'Notes de fin',
        figure: 'Figure',
        table: 'Tableau',
      }
    : {
        contents: 'Contents',
        footnotes: 'Footnotes',
        endnotes: 'Endnotes',
        figure: 'Figure',
        table: 'Table',
      };
  return labels[key];
}
