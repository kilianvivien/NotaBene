/**
 * One row of the shared search results.
 *
 * Extracted when tasks became a third kind: ⌘K and the title-bar field had
 * identical two-branch renderers, and adding a branch to each is exactly how
 * the two entry points quietly become different products — the thing
 * `useCommandSearch` exists to prevent.
 */
import { CheckCircle2, Circle, CornerDownLeft, FileText } from 'lucide-react';
import { HighlightedSnippet } from './HighlightedSnippet';
import type { CommandSearchRow as Row } from './useCommandSearch';

export function CommandSearchRowBody({ row }: { row: Row }) {
  if (row.kind === 'note') {
    return (
      <>
        <FileText size={13} aria-hidden />
        <span className="nb-palette-label">{row.title}</span>
        {row.snippet && (
          <span className="nb-palette-hint">
            <HighlightedSnippet value={row.snippet} />
          </span>
        )}
      </>
    );
  }

  if (row.kind === 'task') {
    return (
      <>
        {row.done ? (
          <CheckCircle2 size={13} aria-hidden className="text-[var(--nb-success)]" />
        ) : (
          <Circle size={13} aria-hidden />
        )}
        <span className={row.done ? 'nb-palette-label line-through' : 'nb-palette-label'}>
          {row.title}
        </span>
        {row.snippet && (
          <span className="nb-palette-hint">
            <HighlightedSnippet value={row.snippet} />
          </span>
        )}
      </>
    );
  }

  return (
    <>
      <CornerDownLeft size={13} aria-hidden />
      <span className="nb-palette-label">{row.label}</span>
      {row.keys && <kbd>{row.keys}</kbd>}
    </>
  );
}
