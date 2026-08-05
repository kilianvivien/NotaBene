/**
 * Flashcards.
 *
 * The list is editable, and that is the point. A generated card is a first
 * draft: the model does not know that the lecturer only ever asks the
 * definition one way round, and a student who cannot fix a card before it
 * enters their spaced-repetition schedule will be re-reading that mistake for
 * a term. Cards can also be dropped — a deck of twelve good cards beats twenty
 * with four duds in it.
 *
 * Two destinations, because a deck has two lives. Anki is where the reviewing
 * actually happens; the note is where it stays findable, and is what makes the
 * deck survive closing this dialog. Neither is the "real" one.
 */
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, FieldNote, GlassButton, GlassSelect } from '@/components/glass';
import type { FlashcardStyle } from '@/lib/ai';
import {
  exportFlashcardsCommand,
  proposeFlashcardsCommand,
  saveFlashcardsToNoteCommand,
} from '@/lib/commands';
import { answerable, newId, type Flashcard, type FlashcardDeck } from '@/lib/schema';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { AiStatusPill } from './AiStatusPill';
import { useAiAvailability } from './useAiAvailability';

const STYLES: FlashcardStyle[] = ['basic', 'cloze', 'mixed'];
const COUNTS = [10, 15, 20, 30];

export function FlashcardsDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.aiFlashcardsOpen);
  const setOpen = useUiStore((state) => state.setAiFlashcardsOpen);
  const multiSelection = useUiStore((state) => state.multiSelection);
  const selectedNoteId = useUiStore((state) => state.selectedNoteId);
  const note = useEditorStore((state) => state.note);
  const courses = useLibraryStore((state) => state.courses);
  const running = useAiStore((state) => state.running) === 'flashcards';
  const availability = useAiAvailability('flashcards');

  const [style, setStyle] = useState<FlashcardStyle>('mixed');
  const [count, setCount] = useState(15);
  const [deck, setDeck] = useState<FlashcardDeck | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const noteIds = multiSelection.length
    ? multiSelection
    : selectedNoteId
      ? [selectedNoteId]
      : [];

  useEffect(() => {
    setDeck(null);
    setError('');
    setStatus('');
    setReviewing(false);
  }, [selectedNoteId]);

  async function generate() {
    setError('');
    setStatus('');
    const signal = beginRun('flashcards');
    const outcome = await proposeFlashcardsCommand({ noteIds, style, count }, { signal });
    endRun('flashcards');

    if (!outcome.ok) {
      setError(
        outcome.code === 'not_supported' ? t('ai.notConfiguredHint') : outcome.message,
      );
      return;
    }
    setDeck(outcome.value);
  }

  function patchCard(id: string, patch: Partial<Flashcard>) {
    setDeck((current) =>
      current
        ? {
            ...current,
            cards: current.cards.map((card) =>
              card.id === id ? { ...card, ...patch } : card,
            ),
          }
        : current,
    );
  }

  function addCard() {
    setDeck((current) =>
      current
        ? {
            ...current,
            cards: [
              ...current.cards,
              { id: newId(), kind: 'basic', front: '', back: '', tags: [] },
            ],
          }
        : current,
    );
  }

  /** Blank cards would import into Anki as cards with nothing on them, so they
   * are dropped on the way out rather than blocking the export. A cloze card
   * with an empty back is not blank — its answer is the deletion on the front. */
  function filled(source: FlashcardDeck): FlashcardDeck {
    return {
      ...source,
      cards: source.cards.filter((card) => card.front.trim() && answerable(card)),
    };
  }

  async function exportDeck() {
    if (!deck) return;
    setError('');
    const courseName = courses.find((course) => course.id === note?.courseId)?.name;
    const outcome = await exportFlashcardsCommand(filled(deck), {
      deckPrefix: courseName,
    });
    if (!outcome.ok) {
      if (outcome.code !== 'not_supported') setError(outcome.message);
      return;
    }
    setStatus(t('ai.deckExported'));
  }

  async function saveToNote() {
    if (!deck || !note) return;
    setError('');
    const outcome = await saveFlashcardsToNoteCommand(note.id, filled(deck));
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setOpen(false);
    setDeck(null);
  }

  const usable = deck ? filled(deck).cards.length : 0;
  const reviewDeck = deck ? filled(deck) : null;
  const reviewCard = reviewDeck?.cards[reviewIndex];

  function reviewMove(delta: number) {
    if (!reviewDeck?.cards.length) return;
    setReviewIndex(
      (current) => (current + delta + reviewDeck.cards.length) % reviewDeck.cards.length,
    );
    setRevealed(false);
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        cancelRun('flashcards');
        setOpen(false);
      }}
      title={t('ai.flashcards')}
      description={t('ai.flashcardsIntro')}
      size="lg"
      headerAction={<AiStatusPill feature="flashcards" compact />}
      footer={
        <>
          {running ? (
            <GlassButton size="sm" onClick={() => cancelRun('flashcards')}>
              {t('ai.cancel')}
            </GlassButton>
          ) : (
            <GlassButton size="sm" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </GlassButton>
          )}
          <GlassButton
            size="sm"
            variant={deck ? 'ghost' : 'accent'}
            disabled={!noteIds.length || !availability.available || running}
            onClick={() => void generate()}
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              deck && <RefreshCw size={12} />
            )}
            {running ? t('ai.running') : deck ? t('ai.regenerate') : t('ai.generate')}
          </GlassButton>
          {deck && (
            <>
              <GlassButton
                size="sm"
                disabled={!usable}
                onClick={() => {
                  setReviewing((current) => !current);
                  setReviewIndex(0);
                  setRevealed(false);
                }}
              >
                <Play size={12} />
                {reviewing ? t('ai.editCards') : t('ai.reviewCards')}
              </GlassButton>
              <GlassButton size="sm" disabled={!usable} onClick={() => void exportDeck()}>
                {t('ai.exportToAnki')}
              </GlassButton>
              <GlassButton
                size="sm"
                variant="accent"
                disabled={!usable || !note}
                onClick={() => void saveToNote()}
              >
                {t('ai.saveToNote')}
              </GlassButton>
            </>
          )}
        </>
      }
    >
      {!deck && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <GlassSelect
              label={t('ai.cardStyle')}
              size="sm"
              value={style}
              onChange={(event) => setStyle(event.target.value as FlashcardStyle)}
            >
              {STYLES.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`ai.cardStyle_${entry}`)}
                </option>
              ))}
            </GlassSelect>
            <GlassSelect
              label={t('ai.cardCount')}
              size="sm"
              value={String(count)}
              onChange={(event) => setCount(Number(event.target.value))}
            >
              {COUNTS.map((entry) => (
                <option key={entry} value={entry}>
                  {t('ai.cardCountValue', { count: entry })}
                </option>
              ))}
            </GlassSelect>
          </div>
          <p className="text-[12px] leading-snug text-nb-text-3">
            {t(`ai.cardStyleHint_${style}`)}
          </p>
          <FieldNote>{t('ai.sourceCount', { count: noteIds.length })}</FieldNote>
        </div>
      )}

      {deck && !reviewing && (
        <div className="flex flex-col gap-2">
          <input
            value={deck.title}
            aria-label={t('ai.deckTitle')}
            onChange={(event) => setDeck({ ...deck, title: event.target.value })}
            className="h-8 w-full rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[13px] font-medium"
          />

          <ol className="flex flex-col gap-1.5">
            {deck.cards.map((card, index) => (
              <li
                key={card.id}
                className="rounded-nb-sm border border-[var(--nb-divider)] p-2"
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] text-nb-text-3">
                    {index + 1}
                    {card.kind === 'cloze' && ` · ${t('ai.cardStyle_cloze')}`}
                  </span>
                  <GlassButton
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    aria-label={t('ai.removeCard')}
                    onClick={() =>
                      setDeck({
                        ...deck,
                        cards: deck.cards.filter((entry) => entry.id !== card.id),
                      })
                    }
                  >
                    <Trash2 size={12} />
                  </GlassButton>
                </div>
                <textarea
                  rows={2}
                  value={card.front}
                  aria-label={t('ai.cardFront')}
                  placeholder={t('ai.cardFront')}
                  onChange={(event) => patchCard(card.id, { front: event.target.value })}
                  className="mb-1 w-full resize-y rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] p-1.5 text-[12px]"
                />
                <textarea
                  rows={2}
                  value={card.back}
                  aria-label={t('ai.cardBack')}
                  placeholder={t('ai.cardBack')}
                  onChange={(event) => patchCard(card.id, { back: event.target.value })}
                  className="w-full resize-y rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] p-1.5 text-[12px] text-nb-text-2"
                />
              </li>
            ))}
          </ol>

          <GlassButton size="sm" variant="ghost" className="self-start" onClick={addCard}>
            <Plus size={12} />
            {t('ai.addCard')}
          </GlassButton>

          <FieldNote>{t('ai.cardsReady', { count: usable })}</FieldNote>
        </div>
      )}

      {reviewing && reviewDeck && reviewCard && (
        <section className="flex min-h-[340px] flex-col" aria-label={t('ai.reviewCards')}>
          <div className="mb-3 flex items-center justify-between text-[11px] text-nb-text-3">
            <span>{reviewDeck.title}</span>
            <span>
              {t('ai.reviewProgress', {
                current: reviewIndex + 1,
                total: reviewDeck.cards.length,
              })}
            </span>
          </div>
          <button
            type="button"
            className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-4 rounded-nb-md border border-[var(--nb-divider)] bg-[var(--nb-paper)] p-8 text-center shadow-[var(--nb-shadow-sm)]"
            aria-label={revealed ? t('ai.cardBack') : t('ai.cardFront')}
            onClick={() => setRevealed((current) => !current)}
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-nb-text-3">
              {revealed ? t('ai.answer') : t('ai.question')}
            </span>
            <span className="max-w-[55ch] text-[18px] leading-relaxed">
              {revealed
                ? reviewCard.kind === 'cloze'
                  ? reviewCard.front.replaceAll(
                      /\{\{c\d+::([^}|]*)(?:\|[^}]*)?\}\}/g,
                      '$1',
                    )
                  : reviewCard.back
                : reviewCard.front.replaceAll(
                    /\{\{c\d+::([^}|]*)(?:\|[^}]*)?\}\}/g,
                    '[…]',
                  )}
            </span>
            {revealed && reviewCard.hint && (
              <span className="text-[12px] text-nb-text-3">{reviewCard.hint}</span>
            )}
            <span className="text-[11px] text-nb-text-3">{t('ai.flipCardHint')}</span>
          </button>
          <div className="mt-3 flex items-center justify-center gap-2">
            <GlassButton
              size="sm"
              variant="ghost"
              aria-label={t('ai.previousCard')}
              onClick={() => reviewMove(-1)}
            >
              <ChevronLeft size={14} />
            </GlassButton>
            <GlassButton
              size="sm"
              variant="accent"
              onClick={() => setRevealed((current) => !current)}
            >
              {revealed ? t('ai.showQuestion') : t('ai.showAnswer')}
            </GlassButton>
            <GlassButton
              size="sm"
              variant="ghost"
              aria-label={t('ai.nextCard')}
              onClick={() => reviewMove(1)}
            >
              <ChevronRight size={14} />
            </GlassButton>
          </div>
        </section>
      )}

      {status && <FieldNote>{status}</FieldNote>}
      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
