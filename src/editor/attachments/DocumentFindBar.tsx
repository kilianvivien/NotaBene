/**
 * The find bar shared by every attachment preview that can be searched.
 *
 * It floats over the document rather than taking a row of its own, the way a
 * reader's find bar does: searching is a moment, and the page keeps the space
 * the rest of the time.
 */
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DocumentFindBarProps {
  query: string;
  /** Total matches, and which one is current — zero-based, -1 when none. */
  count: number;
  index: number;
  busy?: boolean;
  placeholder: string;
  onQuery(value: string): void;
  onStep(direction: -1 | 1): void;
  onClose(): void;
}

export function DocumentFindBar({
  query,
  count,
  index,
  busy = false,
  placeholder,
  onQuery,
  onStep,
  onClose,
}: DocumentFindBarProps) {
  const { t } = useTranslation();

  return (
    <div className="nb-doc-find" role="search">
      <Search size={14} aria-hidden />
      <input
        autoFocus
        value={query}
        type="search"
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          onStep(event.shiftKey ? -1 : 1);
        }}
      />
      <span aria-live="polite">
        {busy
          ? t('find.searching')
          : query.trim()
            ? t('find.matchCount', { current: index >= 0 ? index + 1 : 0, count })
            : ''}
      </span>
      <button
        type="button"
        disabled={!count}
        aria-label={t('find.previous')}
        title={t('find.previous')}
        onClick={() => onStep(-1)}
      >
        <ChevronUp size={14} aria-hidden />
      </button>
      <button
        type="button"
        disabled={!count}
        aria-label={t('find.next')}
        title={t('find.next')}
        onClick={() => onStep(1)}
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t('common.close')}
        title={t('common.close')}
        onClick={onClose}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
