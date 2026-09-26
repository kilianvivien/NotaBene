import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * What the new note will be made from, above the choice: which notes feed it
 * is the first thing to check, and a count at the bottom of the dialog was
 * the last thing anybody read.
 */
export function Sources({ count, titles }: { count: number; titles: string[] }) {
  const { t } = useTranslation();
  const shown = titles.slice(0, 4);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-nb-text-3">
        {t('ai.sourceCount', { count })}
      </span>
      {shown.map((title, index) => (
        <span
          key={`${title}-${index}`}
          className="inline-flex max-w-[16rem] items-center gap-1 rounded-full border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] px-2 py-0.5 text-[11.5px] text-nb-text-2"
        >
          <FileText size={11} aria-hidden className="shrink-0 text-nb-text-3" />
          <span className="truncate">{title}</span>
        </span>
      ))}
      {titles.length > shown.length && (
        <span className="text-[11.5px] text-nb-text-3">
          {t('ai.sourcesMore', { count: titles.length - shown.length })}
        </span>
      )}
    </div>
  );
}
