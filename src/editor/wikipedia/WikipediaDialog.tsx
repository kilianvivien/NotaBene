/**
 * Wikipedia, from inside a note.
 *
 * One search and two things to do with a result, because a student wants two
 * different things from the same article and knowing which one at the moment
 * they find it is the point: a link, when the article is a source the prose
 * should credit, or the article itself, when it is reading for later and the
 * train has no signal.
 *
 * Search-by-title rather than paste-a-URL, which is what makes this a mode
 * rather than a shortcut. Finding the French article on an institution means
 * knowing its exact name; typing three letters and choosing does not.
 *
 * The hint under the field is not filler. This reaches a host nobody
 * configured, and an app that sells "no account, no cloud, no telemetry" owes
 * the student a plain sentence about when that happens — which is when they
 * type here, and at no other time.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, ExternalLink, Loader2, Search } from 'lucide-react';
import { Dialog, FieldNote, GlassButton, GlassPopupButton } from '@/components/glass';
import { HighlightedSnippet } from '@/app/shell/HighlightedSnippet';
import {
  attachWikipediaArticleCommand,
  searchWikipediaCommand,
  WIKIPEDIA_LANGUAGES,
} from '@/lib/commands';
import { excerptSnippet } from '@/lib/import/wikipediaExcerpt';
import type { WikipediaHit } from '@/lib/schema';
import { useSettingsStore } from '@/lib/state/settingsStore';

/** Long enough that typing a word is one request, short enough to feel live. */
const DEBOUNCE_MS = 350;

/** Turn a `code:message` failure into something a student can act on. */
function messageFor(raw: string, t: (key: string) => string): string {
  const code = raw.split(':', 1)[0] ?? '';
  if (code === 'unsupported') return t('wikipedia.needsDesktop');
  if (code === 'http_error' || code === 'fetch_failed' || code === 'dns_failed')
    return t('wikipedia.unreachable');
  if (code === 'not_html') return t('editor.linkNotHtml');
  if (code === 'too_large') return t('editor.linkTooLarge');
  if (code === 'empty_page') return t('editor.linkEmpty');
  return t('wikipedia.failed');
}

export function WikipediaDialog({
  open,
  noteId,
  onClose,
  onInsertLink,
}: {
  open: boolean;
  noteId: string | null;
  onClose(): void;
  /** Put a link to this article in the prose. The editor owns the caret, so
   * the dialog hands over a title and an address rather than a transaction. */
  onInsertLink(hit: WikipediaHit): void;
}) {
  const { t } = useTranslation();
  const locale = useSettingsStore((state) => state.settings.locale);
  const [language, setLanguage] = useState<string>(locale);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<WikipediaHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every search increments this, and a response is only rendered if its ticket
  // is still the current one. Without it a slow "hat" can land after a fast
  // "hatvp" and replace the results with the ones for what was typed first.
  const ticket = useRef(0);

  useEffect(() => {
    if (!open) return;
    setLanguage(locale);
    setQuery('');
    setHits([]);
    setSearching(false);
    setSearched(false);
    setSaving(null);
    setError(null);
    ticket.current += 1;
  }, [open, locale]);

  const search = useCallback(
    async (term: string, lang: string): Promise<void> => {
      const mine = (ticket.current += 1);
      if (!term.trim()) {
        setHits([]);
        setSearching(false);
        setSearched(false);
        return;
      }
      setSearching(true);
      setError(null);
      const result = await searchWikipediaCommand({ language: lang, query: term });
      if (mine !== ticket.current) return;
      setSearching(false);
      setSearched(true);
      if (!result.ok) {
        setHits([]);
        setError(messageFor(result.message, t));
        return;
      }
      setHits(result.value);
    },
    [t],
  );

  // Debounced on the query and the language together: switching edition with a
  // phrase already typed should search again, not wait for another keystroke.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void search(query, language), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query, language, search]);

  async function save(hit: WikipediaHit): Promise<void> {
    if (!noteId || saving) return;
    setSaving(hit.url);
    setError(null);
    const result = await attachWikipediaArticleCommand({ noteId, url: hit.url });
    setSaving(null);
    if (!result.ok) {
      setError(messageFor(result.message, t));
      return;
    }
    // No callback: the command already announced the change, and every
    // attachment list is subscribed to that.
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('wikipedia.title')}
      description={t('wikipedia.hint')}
      size="md"
      footer={
        <GlassButton variant="ghost" onClick={onClose} disabled={saving !== null}>
          {t('common.cancel')}
        </GlassButton>
      }
    >
      <div className="flex items-center gap-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search
            size={13}
            aria-hidden
            className="pointer-events-none absolute left-2.5 text-nb-text-3"
          />
          <input
            data-autofocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void search(query, language);
              }
            }}
            placeholder={t('wikipedia.placeholder')}
            aria-label={t('wikipedia.title')}
            className="w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] py-2 pl-7 pr-2.5 text-[13px] text-nb-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--nb-accent-ring)]"
          />
        </div>
        <GlassPopupButton
          label={t('wikipedia.language')}
          value={language}
          onChange={setLanguage}
          options={WIKIPEDIA_LANGUAGES.map((entry) => ({
            value: entry.code,
            label: entry.label,
          }))}
        />
      </div>

      <ul className="mt-2 max-h-[320px] min-h-[80px] overflow-y-auto" aria-busy={searching}>
        {searching && hits.length === 0 ? (
          <li className="flex items-center gap-2 px-2 py-3 text-[12px] text-nb-text-3">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {t('wikipedia.searching')}
          </li>
        ) : hits.length === 0 ? (
          <li className="px-2 py-3 text-[12px] text-nb-text-3">
            {/* Nothing here while an error is showing below: "type to search"
                under "that could not be reached" reads as advice to try the
                thing that has just failed. */}
            {error ? null : searched ? t('wikipedia.noResults') : t('wikipedia.prompt')}
          </li>
        ) : (
          hits.map((hit) => (
            <li
              key={hit.url}
              className="group rounded-nb-xs px-2 py-2 hover:bg-[var(--nb-hover)]"
            >
              <p className="text-[13px] font-medium text-nb-text">{hit.title}</p>
              {hit.description && (
                <p className="mt-0.5 text-[11px] text-nb-text-3">{hit.description}</p>
              )}
              {hit.excerpt && (
                <p className="mt-1 line-clamp-2 text-[12px] text-nb-text-2">
                  <HighlightedSnippet value={excerptSnippet(hit.excerpt)} />
                </p>
              )}
              <div className="mt-1.5 flex items-center gap-1.5">
                <GlassButton
                  size="sm"
                  variant="ghost"
                  disabled={saving !== null}
                  onClick={() => {
                    onInsertLink(hit);
                    onClose();
                  }}
                >
                  <ExternalLink size={12} aria-hidden />
                  {t('wikipedia.insertLink')}
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="ghost"
                  // Saving needs somewhere to put the attachment. The link does
                  // not, which is why only this one goes away without a note.
                  disabled={!noteId || saving !== null}
                  title={noteId ? undefined : t('wikipedia.needsNote')}
                  onClick={() => void save(hit)}
                >
                  {saving === hit.url ? (
                    <Loader2 size={12} className="animate-spin" aria-hidden />
                  ) : (
                    <BookOpen size={12} aria-hidden />
                  )}
                  {saving === hit.url ? t('wikipedia.saving') : t('wikipedia.saveArticle')}
                </GlassButton>
              </div>
            </li>
          ))
        )}
      </ul>

      {error ? (
        <FieldNote tone="danger">{error}</FieldNote>
      ) : (
        <FieldNote>{t('wikipedia.savedOffline')}</FieldNote>
      )}
    </Dialog>
  );
}
