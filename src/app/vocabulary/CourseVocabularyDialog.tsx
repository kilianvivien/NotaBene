/**
 * A course's vocabulary, where the student can see and steer it.
 *
 * Four views of one list. "Your words" and "Never suggested" are what the
 * student decided, and the only part of the vocabulary that is library data.
 * "Found in notes" is what the completer derived on its own, shown so a
 * student can promote a word or silence one without waiting for it to be
 * suggested wrongly first. "Review with AI" asks a model for corrections and
 * missing terms, and writes nothing until the student ticks what to keep.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Check, Loader2, Plus, Sparkles, Undo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  FieldNote,
  GlassButton,
  GlassScrollArea,
  GlassSegmentedControl,
} from '@/components/glass';
import { AiDialogStatus } from '@/app/ai/AiDisclosure';
import { useAiAvailability } from '@/app/ai/useAiAvailability';
import { MAX_VOCABULARY_MATERIAL_CHARS } from '@/lib/ai';
import {
  applyVocabularyReviewCommand,
  proposeVocabularyCommand,
  removeCourseTermCommand,
  setCourseTermCommand,
  type VocabularyProposal,
} from '@/lib/commands';
import {
  MAX_COURSE_TERM_LENGTH,
  type CourseTerm,
  type CourseTermStatus,
} from '@/lib/schema';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { foldKey, loadCourseVocabulary, type CourseVocabulary } from '@/lib/vocabulary';

type Tab = 'accepted' | 'found' | 'rejected' | 'review';

/** How much of the harvest to list. The rest still completes; this is a
 * window onto the words that matter most, not an inventory. */
const FOUND_LIMIT = 200;

const INPUT_CLASS =
  'h-8 w-full min-w-0 rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2.5 text-[13px] text-nb-text focus:outline-none focus:ring-2 focus:ring-[var(--nb-accent-ring)]';

export function CourseVocabularyDialog() {
  const request = useUiStore((state) => state.vocabularyRequest);
  const close = useUiStore((state) => state.closeVocabulary);
  // Keyed on the request so every opening starts from a clean slate.
  return request ? (
    <VocabularyDialogBody
      key={`${request.courseId}:${request.review}`}
      courseId={request.courseId}
      initialTab={request.review ? 'review' : 'accepted'}
      onClose={close}
    />
  ) : null;
}

function VocabularyDialogBody({
  courseId,
  initialTab,
  onClose,
}: {
  courseId: string;
  initialTab: Tab;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const course = useLibraryStore((state) =>
    state.courses.find((entry) => entry.id === courseId),
  );
  const [tab, setTab] = useState<Tab>(initialTab);
  const [vocabulary, setVocabulary] = useState<CourseVocabulary | null>(null);
  const [newWord, setNewWord] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setVocabulary(await loadCourseVocabulary(courseId));
    } catch {
      setError(t('vocabulary.loadFailed'));
    }
  }, [courseId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const accepted = useMemo(
    () => vocabulary?.curated.filter((entry) => entry.status === 'accepted') ?? [],
    [vocabulary],
  );
  const rejected = useMemo(
    () => vocabulary?.curated.filter((entry) => entry.status === 'rejected') ?? [],
    [vocabulary],
  );
  const found = useMemo(() => {
    if (!vocabulary) return [];
    const decided = new Set(vocabulary.curated.map((entry) => foldKey(entry.term)));
    const needle = foldKey(filter.trim());
    return vocabulary.harvested
      .filter(
        (entry) => !decided.has(entry.key) && (!needle || entry.key.includes(needle)),
      )
      .slice(0, FOUND_LIMIT);
  }, [vocabulary, filter]);

  async function decide(term: string, status: CourseTermStatus): Promise<void> {
    setError('');
    const result = await setCourseTermCommand({ courseId, term, status });
    if (!result.ok) {
      setError(
        result.code === 'invalid_input'
          ? t('vocabulary.notATerm')
          : t('vocabulary.saveFailed'),
      );
      return;
    }
    // Patched in place rather than reloaded: a reload re-harvests every note
    // in the course, which is a noticeable pause per click in a big one. The
    // command matched by folded spelling, so the list does the same.
    const saved = result.value;
    const key = foldKey(saved.term);
    setVocabulary((current) =>
      current
        ? {
            ...current,
            curated: [
              ...current.curated.filter(
                (entry) => entry.id !== saved.id && foldKey(entry.term) !== key,
              ),
              saved,
            ].sort((a, b) => a.term.localeCompare(b.term)),
          }
        : current,
    );
  }

  async function remove(term: CourseTerm): Promise<void> {
    setError('');
    const result = await removeCourseTermCommand(term.id);
    if (!result.ok) {
      setError(t('vocabulary.saveFailed'));
      return;
    }
    setVocabulary((current) =>
      current
        ? { ...current, curated: current.curated.filter((entry) => entry.id !== term.id) }
        : current,
    );
  }

  async function addTyped(): Promise<void> {
    const word = newWord.trim();
    if (!word) return;
    await decide(word, 'accepted');
    setNewWord('');
  }

  const review = useReview(courseId, reload, tab === 'review');

  // Stable: `ModalOverlay` rebuilds its focus trap whenever this changes.
  const handleClose = useCallback((): void => {
    cancelRun('vocabulary');
    onClose();
  }, [onClose]);

  const title = course
    ? t('vocabulary.titleFor', { course: `${course.icon} ${course.name}` })
    : t('vocabulary.title');

  return (
    <Dialog
      open
      onClose={handleClose}
      title={title}
      description={t('vocabulary.hint')}
      size="lg"
      headerAction={
        tab === 'review' ? (
          <AiDialogStatus feature="vocabulary" onLeave={handleClose} />
        ) : undefined
      }
      footer={
        tab === 'review' ? (
          review.renderFooter(handleClose)
        ) : (
          <GlassButton size="sm" onClick={handleClose}>
            {t('common.close')}
          </GlassButton>
        )
      }
    >
      <GlassSegmentedControl<Tab>
        fill
        label={t('vocabulary.title')}
        value={tab}
        onChange={setTab}
        options={[
          {
            value: 'accepted',
            label: t('vocabulary.tabAccepted', { count: accepted.length }),
          },
          { value: 'found', label: t('vocabulary.tabFound') },
          {
            value: 'rejected',
            label: t('vocabulary.tabRejected', { count: rejected.length }),
          },
          { value: 'review', label: t('vocabulary.tabReview') },
        ]}
      />

      <div className="mt-3">
        {tab === 'accepted' && (
          <>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void addTyped();
              }}
            >
              <input
                data-autofocus
                value={newWord}
                maxLength={MAX_COURSE_TERM_LENGTH}
                onChange={(event) => setNewWord(event.target.value)}
                placeholder={t('vocabulary.addPlaceholder')}
                aria-label={t('vocabulary.addPlaceholder')}
                className={INPUT_CLASS}
              />
              <GlassButton size="sm" type="submit" disabled={!newWord.trim()}>
                <Plus size={12} aria-hidden />
                {t('vocabulary.add')}
              </GlassButton>
            </form>
            <TermList
              loading={!vocabulary}
              empty={t('vocabulary.emptyAccepted')}
              terms={accepted}
              aiLabel={t('vocabulary.fromAi')}
              actionLabel={t('vocabulary.remove')}
              actionIcon={<X size={12} aria-hidden />}
              onAction={(term) => void remove(term)}
            />
          </>
        )}

        {tab === 'found' && (
          <>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('vocabulary.filter')}
              aria-label={t('vocabulary.filter')}
              className={INPUT_CLASS}
            />
            <GlassScrollArea className="mt-2 max-h-[340px]">
              {!vocabulary ? (
                <Loading />
              ) : found.length === 0 ? (
                <Empty text={t('vocabulary.emptyFound')} />
              ) : (
                <ul className="divide-y divide-[var(--nb-divider)]">
                  {found.map((entry) => (
                    <li key={entry.key} className="flex items-center gap-2 px-1 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-nb-text">
                        {entry.term}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-nb-text-3">
                        {t('vocabulary.usage', { count: entry.count })}
                      </span>
                      <RowButton
                        label={t('vocabulary.keep')}
                        onClick={() => void decide(entry.term, 'accepted')}
                      >
                        <Plus size={12} aria-hidden />
                      </RowButton>
                      <RowButton
                        label={t('vocabulary.neverSuggest')}
                        danger
                        onClick={() => void decide(entry.term, 'rejected')}
                      >
                        <Ban size={12} aria-hidden />
                      </RowButton>
                    </li>
                  ))}
                </ul>
              )}
            </GlassScrollArea>
            <FieldNote>{t('vocabulary.foundHint')}</FieldNote>
          </>
        )}

        {tab === 'rejected' && (
          <>
            <TermList
              loading={!vocabulary}
              empty={t('vocabulary.emptyRejected')}
              terms={rejected}
              aiLabel={t('vocabulary.fromAi')}
              actionLabel={t('vocabulary.allowAgain')}
              actionIcon={<Undo2 size={12} aria-hidden />}
              onAction={(term) => void remove(term)}
            />
            <FieldNote>{t('vocabulary.rejectedHint')}</FieldNote>
          </>
        )}

        {tab === 'review' && review.renderBody()}
      </div>

      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// AI review
// ---------------------------------------------------------------------------

/** Keys for the three kinds of proposal, so one `Set` can hold every tick. */
const correctionKey = (index: number) => `c${index}`;
const termKey = (index: number) => `t${index}`;
const acronymKey = (index: number) => `a${index}`;

function allKeys(proposal: VocabularyProposal): Set<string> {
  return new Set([
    ...proposal.corrections.map((_, index) => correctionKey(index)),
    ...proposal.terms.map((_, index) => termKey(index)),
    ...proposal.acronyms.map((_, index) => acronymKey(index)),
  ]);
}

/**
 * The review tab's state, and the two pieces of UI that read it. A hook
 * rather than a child component because the footer lives in the dialog's
 * footer slot and the body in its content, and both have to agree.
 */
function useReview(courseId: string, reload: () => Promise<void>, visible: boolean) {
  const { t } = useTranslation();
  const running = useAiStore((state) => state.running) === 'vocabulary';
  // Only while the tab is showing: availability asks local runtimes what they
  // have loaded, and the word lists have no reason to.
  const availability = useAiAvailability('vocabulary', visible);
  const [material, setMaterial] = useState('');
  const [proposal, setProposal] = useState<VocabularyProposal | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{
    tone: 'danger' | 'default';
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  async function run(): Promise<void> {
    setMessage(null);
    const signal = beginRun('vocabulary');
    const outcome = await proposeVocabularyCommand({ courseId, material }, { signal });
    endRun('vocabulary', signal);
    if (!outcome.ok) {
      if (outcome.code === 'cancelled') return;
      setMessage({
        tone: 'danger',
        text:
          outcome.code === 'not_supported'
            ? t('ai.notConfiguredHint')
            : outcome.code === 'invalid_input'
              ? t('vocabulary.nothingToReview')
              : outcome.message,
      });
      return;
    }
    setProposal(outcome.value);
    setChosen(allKeys(outcome.value));
  }

  async function apply(): Promise<void> {
    if (!proposal) return;
    setSaving(true);
    const result = await applyVocabularyReviewCommand(courseId, {
      corrections: proposal.corrections.filter((_, index) =>
        chosen.has(correctionKey(index)),
      ),
      terms: proposal.terms.filter((_, index) => chosen.has(termKey(index))),
      acronyms: proposal.acronyms.filter((_, index) => chosen.has(acronymKey(index))),
    });
    setSaving(false);
    if (!result.ok) {
      setMessage({ tone: 'danger', text: t('vocabulary.saveFailed') });
      return;
    }
    setProposal(null);
    setChosen(new Set());
    setMessage({
      tone: 'default',
      text: t('vocabulary.reviewApplied', {
        terms: result.value.terms,
        abbreviations: result.value.abbreviations,
      }),
    });
    await reload();
  }

  function toggle(key: string): void {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const empty =
    proposal !== null &&
    !proposal.corrections.length &&
    !proposal.terms.length &&
    !proposal.acronyms.length;

  // Render functions, not components: a component defined inside a hook is a
  // new type every render, and the textarea would remount on each keystroke.
  function renderBody() {
    return (
      <div className="flex flex-col gap-3">
        {!proposal && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-nb-text-2">
              {t('vocabulary.material')}
            </span>
            <textarea
              value={material}
              maxLength={MAX_VOCABULARY_MATERIAL_CHARS}
              onChange={(event) => setMaterial(event.target.value)}
              placeholder={t('vocabulary.materialPlaceholder')}
              rows={6}
              className="w-full resize-y rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] p-2.5 text-[12.5px] leading-relaxed text-nb-text focus:outline-none focus:ring-2 focus:ring-[var(--nb-accent-ring)]"
            />
            <FieldNote>{t('vocabulary.reviewPrivacy')}</FieldNote>
          </label>
        )}

        {running && !proposal && <Loading text={t('vocabulary.reviewing')} />}

        {empty && <Empty text={t('vocabulary.reviewEmpty')} />}

        {proposal && !empty && (
          <GlassScrollArea className="max-h-[360px]">
            <ProposalGroup
              title={t('vocabulary.corrections')}
              hint={t('vocabulary.correctionsHint')}
            >
              {proposal.corrections.map((entry, index) => (
                <ProposalRow
                  key={correctionKey(index)}
                  checked={chosen.has(correctionKey(index))}
                  onToggle={() => toggle(correctionKey(index))}
                  detail={entry.reason}
                >
                  <span className="text-nb-text-3 line-through">{entry.from}</span>
                  {' → '}
                  <span className="font-medium">{entry.to}</span>
                </ProposalRow>
              ))}
            </ProposalGroup>
            <ProposalGroup
              title={t('vocabulary.newTerms')}
              hint={t('vocabulary.newTermsHint')}
            >
              {proposal.terms.map((term, index) => (
                <ProposalRow
                  key={termKey(index)}
                  checked={chosen.has(termKey(index))}
                  onToggle={() => toggle(termKey(index))}
                >
                  {term}
                </ProposalRow>
              ))}
            </ProposalGroup>
            <ProposalGroup
              title={t('vocabulary.acronyms')}
              hint={t('vocabulary.acronymsHint')}
            >
              {proposal.acronyms.map((entry, index) => (
                <ProposalRow
                  key={acronymKey(index)}
                  checked={chosen.has(acronymKey(index))}
                  onToggle={() => toggle(acronymKey(index))}
                >
                  <span className="font-mono">{entry.acronym}</span>
                  {' → '}
                  {entry.expansion}
                </ProposalRow>
              ))}
            </ProposalGroup>
          </GlassScrollArea>
        )}

        {message && (
          <FieldNote tone={message.tone === 'danger' ? 'danger' : 'notice'}>
            {message.text}
          </FieldNote>
        )}
      </div>
    );
  }

  function renderFooter(onClose: () => void) {
    return (
      <>
        {running ? (
          <GlassButton size="sm" onClick={() => cancelRun('vocabulary')}>
            {t('ai.cancel')}
          </GlassButton>
        ) : (
          <GlassButton size="sm" variant="ghost" onClick={onClose}>
            {t('common.close')}
          </GlassButton>
        )}
        {proposal ? (
          <>
            <GlassButton size="sm" variant="ghost" onClick={() => setProposal(null)}>
              {t('vocabulary.startOver')}
            </GlassButton>
            {!empty && (
              <GlassButton
                size="sm"
                variant="accent"
                disabled={chosen.size === 0 || saving}
                onClick={() => void apply()}
              >
                <Check size={12} aria-hidden />
                {t('vocabulary.applyReview', { count: chosen.size })}
              </GlassButton>
            )}
          </>
        ) : (
          <GlassButton
            size="sm"
            variant="accent"
            disabled={!availability.available || running}
            onClick={() => void run()}
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} aria-hidden />
            )}
            {running ? t('ai.running') : t('vocabulary.runReview')}
          </GlassButton>
        )}
      </>
    );
  }

  return { renderBody, renderFooter };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function TermList({
  loading,
  empty,
  terms,
  aiLabel,
  actionLabel,
  actionIcon,
  onAction,
}: {
  loading: boolean;
  empty: string;
  terms: CourseTerm[];
  aiLabel: string;
  actionLabel: string;
  actionIcon: React.ReactNode;
  onAction(term: CourseTerm): void;
}) {
  if (loading) return <Loading />;
  if (!terms.length) return <Empty text={empty} />;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {terms.map((term) => (
        <li
          key={term.id}
          className="flex items-center gap-1 rounded-full border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] py-0.5 pl-2.5 pr-1 text-[12.5px] text-nb-text"
        >
          {term.term}
          {term.source === 'ai' && (
            <span
              title={aiLabel}
              className="rounded-full bg-[var(--nb-accent-soft)] px-1.5 text-[10px] font-semibold uppercase tracking-wide text-nb-text-2"
            >
              {aiLabel}
            </span>
          )}
          <RowButton
            label={`${actionLabel} — ${term.term}`}
            onClick={() => onAction(term)}
          >
            {actionIcon}
          </RowButton>
        </li>
      ))}
    </ul>
  );
}

function RowButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-nb-xs text-nb-text-3 hover:bg-[var(--nb-hover)]',
        danger ? 'hover:text-[var(--nb-danger)]' : 'hover:text-nb-text',
      )}
    >
      {children}
    </button>
  );
}

function ProposalGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode[];
}) {
  if (!children.length) return null;
  return (
    <section className="mb-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-nb-text-3">
        {title}
      </h3>
      <p className="mb-1 text-[11.5px] text-nb-text-3">{hint}</p>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

function ProposalRow({
  checked,
  onToggle,
  detail,
  children,
}: {
  checked: boolean;
  onToggle(): void;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <label
        className={cn(
          'flex cursor-pointer items-start gap-2.5 rounded-nb-sm px-2 py-1',
          'hover:bg-[var(--nb-hover)]',
          !checked && 'opacity-55',
        )}
      >
        <input
          type="checkbox"
          className="mt-[3px] accent-[var(--nb-accent)]"
          checked={checked}
          onChange={onToggle}
        />
        <span className="min-w-0 flex-1 text-[13px] leading-snug text-nb-text">
          {children}
          {detail && (
            <span className="mt-0.5 block text-[11.5px] leading-snug text-nb-text-3">
              {detail}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

function Loading({ text }: { text?: string }) {
  return (
    <p className="flex h-20 items-center justify-center gap-2 text-[12px] text-nb-text-3">
      <Loader2 size={13} className="animate-spin" aria-hidden />
      {text}
    </p>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="flex h-20 items-center justify-center px-6 text-center text-[12px] text-nb-text-3">
      {text}
    </p>
  );
}
