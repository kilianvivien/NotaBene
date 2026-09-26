/**
 * A course's vocabulary as a cloud: the more a word is used, the larger it is.
 *
 * The list answers "is this word in there?"; the cloud answers "what is this
 * course about?", which is the question a student opening the dialog usually
 * has first. The heaviest words sit in the middle and lighter ones fan out
 * to both sides, so the eye lands on the course's core terms first. The order
 * is deterministic (weight, then spelling), so the cloud does not reshuffle
 * between openings; the filter is how a particular word is found.
 *
 * Size follows the square root of use, not use itself: a course's top word is
 * often ten times as frequent as its twentieth, and a linear scale would draw
 * one giant word over a field of specks.
 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ban, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, type ContextPoint } from '@/components/glass';
import { cn } from '@/lib/utils/cn';

export interface CloudWord {
  key: string;
  term: string;
  /** Uses across the course's notes. */
  count: number;
  /** Distinct notes it occurs in. */
  notes: number;
  /** On the student's own list. */
  accepted: boolean;
}

const MIN_SIZE = 13;
const MAX_SIZE = 34;

/** Heaviest first, then placed alternately after and before it: the middle
 * of the sequence — the middle rows once it wraps — holds the biggest words. */
function centreOut<T>(sorted: T[]): T[] {
  const placed: T[] = [];
  sorted.forEach((item, index) => {
    if (index % 2 === 0) placed.push(item);
    else placed.unshift(item);
  });
  return placed;
}

export function WordCloud({
  words,
  onKeep,
  onNever,
  onRemove,
}: {
  words: CloudWord[];
  onKeep(word: CloudWord): void;
  onNever(word: CloudWord): void;
  onRemove(word: CloudWord): void;
}) {
  const { t, i18n } = useTranslation();
  const [menu, setMenu] = useState<{ word: CloudWord; point: ContextPoint } | null>(null);

  const usage = (word: CloudWord): string =>
    word.notes
      ? t('vocabulary.usage', { uses: word.count, count: word.notes })
      : t('vocabulary.unused');

  const laidOut = useMemo(() => {
    const weights = words.map((word) => Math.sqrt(word.count));
    const low = Math.min(...weights);
    const high = Math.max(...weights);
    const span = high - low || 1;
    const collator = new Intl.Collator(i18n.language, { sensitivity: 'base' });
    return centreOut(
      words
        .map((word, index) => {
          const share = ((weights[index] ?? low) - low) / span;
          return { word, share, size: MIN_SIZE + share * (MAX_SIZE - MIN_SIZE) };
        })
        .sort(
          (a, b) =>
            b.word.count - a.word.count || collator.compare(a.word.term, b.word.term),
        ),
    );
  }, [words, i18n.language]);

  return (
    <>
      <div className="rounded-nb-md border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] px-5 pb-3 pt-5">
        <ul
          aria-label={t('vocabulary.cloudLabel')}
          className="flex min-h-[150px] flex-wrap content-center items-center justify-center gap-x-4 gap-y-2"
        >
          {laidOut.map(({ word, share, size }, index) => (
            <li
              key={word.key}
              className="nb-cloud-word"
              style={{ animationDelay: `${Math.min(index, 40) * 12}ms` }}
            >
              <button
                type="button"
                title={usage(word)}
                aria-haspopup="menu"
                aria-expanded={menu?.word.key === word.key}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  if (menu?.word.key === word.key) {
                    setMenu(null);
                    return;
                  }
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ word, point: { x: rect.left, y: rect.bottom + 4 } });
                }}
                style={{
                  fontSize: `${size.toFixed(1)}px`,
                  // Large type set at text spacing looks loose; tighten it as
                  // it grows, the way display faces are tracked.
                  letterSpacing: `${(-0.02 * share).toFixed(3)}em`,
                }}
                className={cn(
                  'rounded-nb-sm px-1.5 py-0.5 font-[family-name:var(--nb-font-serif)] leading-none',
                  'transition-[color,background-color] duration-[var(--nb-t-fast)]',
                  'hover:bg-[var(--nb-hover)] hover:text-nb-text',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]',
                  share > 0.66
                    ? 'font-semibold'
                    : share > 0.33
                      ? 'font-medium'
                      : 'font-normal',
                  word.accepted
                    ? 'text-[var(--nb-accent)] hover:text-[var(--nb-accent)]'
                    : share > 0.66
                      ? 'text-nb-text'
                      : share > 0.2
                        ? 'text-nb-text-2'
                        : 'text-nb-text-3',
                  menu?.word.key === word.key && 'bg-[var(--nb-hover)]',
                )}
              >
                {word.term}
              </button>
            </li>
          ))}
        </ul>

        <div
          aria-hidden
          className="mt-4 flex items-center justify-between border-t border-[var(--nb-divider)] pt-2.5 text-[11px] text-nb-text-3"
        >
          <span className="flex items-baseline gap-1.5">
            {t('vocabulary.cloudRare')}
            {[MIN_SIZE, (MIN_SIZE + MAX_SIZE) / 2, MAX_SIZE].map((size) => (
              <span
                key={size}
                className="font-[family-name:var(--nb-font-serif)] leading-none text-nb-text-2"
                style={{ fontSize: `${Math.round(size * 0.6)}px` }}
              >
                Aa
              </span>
            ))}
            {t('vocabulary.cloudFrequent')}
          </span>
          {words.some((word) => word.accepted) && (
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-[var(--nb-accent)]" />
              {t('vocabulary.cloudYours')}
            </span>
          )}
        </div>
      </div>

      {/* Portalled: the dialog panel keeps the transform of its entrance
          animation and clips its overflow, and a `position: fixed` menu
          inside it is laid out against the panel rather than the window. */}
      {menu &&
        createPortal(
          <ContextMenu
            point={menu.point}
            header={
              <span>
                <span className="font-semibold text-nb-text">{menu.word.term}</span>
                <span className="ml-1.5 tabular-nums">{usage(menu.word)}</span>
              </span>
            }
            onClose={() => setMenu(null)}
            items={[
              menu.word.accepted
                ? {
                    id: 'remove',
                    label: t('vocabulary.removeFromYours'),
                    icon: X,
                    onSelect: () => onRemove(menu.word),
                  }
                : {
                    id: 'keep',
                    label: t('vocabulary.keep'),
                    icon: Plus,
                    onSelect: () => onKeep(menu.word),
                  },
              {
                id: 'never',
                label: t('vocabulary.neverSuggest'),
                icon: Ban,
                danger: true,
                onSelect: () => onNever(menu.word),
              },
            ]}
          />,
          document.body,
        )}
    </>
  );
}
