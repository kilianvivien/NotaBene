/**
 * Links a model proposed, waiting for an answer.
 *
 * Each one is an opinion about the student's own notes, so each one arrives
 * with its reason and is theirs to accept or wave away — nothing here is
 * written until *Link* is pressed, and pressing it is one versioned edit to
 * one note. *Link all* exists because twelve good suggestions should not take
 * twelve clicks, and sits apart from the rows so it is never pressed by habit.
 */
import { ArrowRight, Loader2, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { suggestionKey, type LinkSuggestion } from '@/lib/ai';

export interface SuggestionRow extends LinkSuggestion {
  sourceTitle: string;
  targetTitle: string;
  sourceColour: string;
  targetColour: string;
}

interface GraphSuggestionsProps {
  rows: SuggestionRow[];
  /** Notes the model was shown, and how many there are in all. */
  considered: number;
  total: number;
  /** The suggestion being written, or `all`. */
  busy: string | null;
  error: string;
  readOnly: boolean;
  onAccept(row: SuggestionRow): void;
  onAcceptAll(): void;
  onDismiss(row: SuggestionRow): void;
  /** Light both ends on the canvas while a row is hovered or focused. */
  onPreview(row: SuggestionRow | null): void;
  onClose(): void;
}

function Dot({ colour }: { colour: string }) {
  return (
    <span className="nb-graph-dot" style={{ background: colour || 'var(--nb-text-3)' }} />
  );
}

export function GraphSuggestions({
  rows,
  considered,
  total,
  busy,
  error,
  readOnly,
  onAccept,
  onAcceptAll,
  onDismiss,
  onPreview,
  onClose,
}: GraphSuggestionsProps) {
  const { t } = useTranslation();
  return (
    <aside
      className="nb-graph-suggest"
      aria-label={t('graph.suggest.title')}
      // On the stage, like the detail card: its clicks are not the graph's.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <header>
        <h3>
          <Sparkles size={13} aria-hidden />
          {t('graph.suggest.title')}
          {rows.length > 0 && <span>{rows.length}</span>}
        </h3>
        <button
          type="button"
          className="nb-graph-detail-close"
          aria-label={t('graph.suggest.close')}
          title={t('graph.suggest.close')}
          onClick={onClose}
        >
          <X size={13} />
        </button>
      </header>

      <div className="nb-graph-suggest-body">
        {rows.length === 0 ? (
          <p className="nb-graph-suggest-none">{t('graph.suggest.none')}</p>
        ) : (
          <>
            <p className="nb-graph-suggest-lead">{t('graph.suggest.lead')}</p>
            <ul>
              {rows.map((row) => {
                const key = suggestionKey(row);
                return (
                  <li
                    key={key}
                    onMouseEnter={() => onPreview(row)}
                    onMouseLeave={() => onPreview(null)}
                    onFocus={() => onPreview(row)}
                    onBlur={() => onPreview(null)}
                  >
                    <p className="nb-graph-suggest-pair">
                      <Dot colour={row.sourceColour} />
                      <span>{row.sourceTitle}</span>
                    </p>
                    <p className="nb-graph-suggest-pair">
                      <ArrowRight size={12} aria-hidden />
                      <Dot colour={row.targetColour} />
                      <span>{row.targetTitle}</span>
                    </p>
                    <p className="nb-graph-suggest-reason">{row.reason}</p>
                    {!readOnly && (
                      <p className="nb-graph-suggest-actions">
                        <button
                          type="button"
                          className="is-primary"
                          disabled={busy !== null}
                          title={t('graph.suggest.linkHint', { title: row.sourceTitle })}
                          onClick={() => onAccept(row)}
                        >
                          {busy === key && <Loader2 size={11} className="animate-spin" />}
                          {t('inspector.mentionLink')}
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => onDismiss(row)}
                        >
                          {t('graph.suggest.ignore')}
                        </button>
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {error && (
          <p role="alert" className="nb-graph-detail-error">
            {error}
          </p>
        )}
        {considered < total && (
          <p className="nb-graph-suggest-note">
            {t('graph.suggest.partial', { considered, total })}
          </p>
        )}
      </div>

      {rows.length > 1 && !readOnly && (
        <footer>
          <button type="button" disabled={busy !== null} onClick={onAcceptAll}>
            {busy === 'all' && <Loader2 size={12} className="animate-spin" />}
            {t('graph.suggest.linkAll', { count: rows.length })}
          </button>
        </footer>
      )}
    </aside>
  );
}
