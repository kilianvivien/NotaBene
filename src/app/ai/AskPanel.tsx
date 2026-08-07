/**
 * Ask a question about the open note, its course, or the whole library.
 *
 * The inspector's AI tab, and the only AI surface that is a conversation rather
 * than a one-shot action — because the question a student actually has ("wait,
 * why does that follow?") is rarely answered in one turn.
 *
 * It streams, and the cancel button works mid-answer. It writes nothing: the
 * thread lives in `aiStore` for as long as the app is open and is never
 * persisted, so nothing here can reach a backup or an export. The one way an
 * answer becomes durable is the explicit "save as note" action, which goes
 * through the command layer like everything else.
 */
import {
  Check,
  ChevronRight,
  Copy,
  Eraser,
  FileText,
  Files,
  GraduationCap,
  Loader2,
  Send,
  Sparkles,
  StickyNote,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, GlassPopupButton } from '@/components/glass';
import type { AskMode, AskScope, AskTurn } from '@/lib/ai';
import { askAboutNotesCommand, saveAnswerAsNoteCommand } from '@/lib/commands';
import {
  beginRun,
  cancelRun,
  endRun,
  threadKey,
  EMPTY_THREAD,
  useAiStore,
} from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { AiDisclosureButton } from './AiDisclosure';
import { AiStatusPill } from './AiStatusPill';
import { AiRichText } from './AiRichText';
import { useAiAvailability } from './useAiAvailability';

const SUGGESTIONS = ['summary', 'explain', 'quiz'] as const;

/** The scope button wears its own value. `Files` is the sidebar's glyph for
 * "All notes", so widening the search points at the row it widens to. */
const SCOPE_ICONS: Record<AskScope, LucideIcon> = {
  note: FileText,
  course: GraduationCap,
  library: Files,
};

/** Enough for four or five lines; past that the thread matters more. */
const COMPOSER_MAX_HEIGHT = 108;

export function AskPanel({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const mode = useAiStore((state) => state.askMode);
  const scope = useAiStore((state) => state.askScope);
  const key = threadKey(mode, scope);
  const thread =
    useAiStore((state) => state.threads[noteId]?.[threadKey(state.askMode, state.askScope)]) ??
    EMPTY_THREAD;
  const running = useAiStore((state) => state.running) === 'ask';
  const clearThread = useAiStore((state) => state.clearThread);
  const setAskMode = useAiStore((state) => state.setAskMode);
  const setAskScope = useAiStore((state) => state.setAskScope);
  const selectNote = useUiStore((state) => state.selectNote);
  const availability = useAiAvailability('ask');

  const knowledge = mode === 'knowledge';
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const empty = !thread.turns.length && !thread.streaming;

  // Follow the stream. A panel that makes you scroll to watch an answer arrive
  // is a panel you stop watching.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.turns.length, thread.streaming]);

  // Grow with the question instead of scrolling a two-line box — a pasted
  // exam prompt is one of the questions this panel is for.
  useEffect(() => {
    const field = composerRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [question]);

  function applySuggestion(text: string) {
    setQuestion(text);
    composerRef.current?.focus();
  }

  async function ask() {
    const asked = question.trim();
    if (!asked || !note) return;

    setError('');
    setQuestion('');
    // The thread a request belongs to is fixed when it starts: switching mode
    // or scope mid-answer must not drop the answer into the wrong conversation.
    const requestKey = key;
    const store = useAiStore.getState();
    store.commitTurn(noteId, requestKey, { role: 'user', content: asked });

    const signal = beginRun('ask');
    const result = await askAboutNotesCommand(
      {
        noteIds: [noteId],
        scope,
        mode,
        question: asked,
        history: thread.turns,
      },
      {
        signal,
        onToken: (token) => useAiStore.getState().appendToken(noteId, requestKey, token),
      },
    );
    endRun('ask');

    if (result.ok) {
      store.commitTurn(noteId, requestKey, {
        role: 'assistant',
        content: result.value.answer,
        sources: result.value.sources,
        droppedCount: result.value.droppedCount,
      });
      return;
    }

    // A cancelled answer keeps whatever streamed in — the student asked to
    // stop, not to throw away the half they had already read.
    const partial = useAiStore.getState().threads[noteId]?.[requestKey]?.streaming ?? '';
    if (partial) {
      store.commitTurn(noteId, requestKey, {
        role: 'assistant',
        content: partial,
      });
    } else {
      store.discardStreaming(noteId, requestKey);
    }
    setError(
      result.code === 'not_supported' ? t('ai.notConfiguredHint') : result.message,
    );
  }

  /** A citation is a way back into the note, which is the point of showing it. */
  async function openSource(sourceNoteId: string) {
    selectNote(sourceNoteId);
    await useEditorStore.getState().openNote(sourceNoteId);
  }

  async function saveAnswer(answer: string, forQuestion: string) {
    if (!note) return;
    const result = await saveAnswerAsNoteCommand(note, forQuestion, answer);
    if (result.ok) {
      selectNote(result.value.id);
      await useEditorStore.getState().openNote(result.value.id);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      {/* Two axes and a thread action on one line. They were three full-width
          rows — a status pill and two segmented controls — which is a lot of
          chrome to read past on the way to the question, and at 280px the
          three scope labels had no room to be words. */}
      <div className="-ml-1.5 flex items-center gap-0.5">
        <GlassPopupButton<AskScope>
          label={t('ai.askScope')}
          value={scope}
          onChange={setAskScope}
          disabled={running}
          icon={SCOPE_ICONS[scope]}
          className="shrink"
          options={[
            { value: 'note', label: t('ai.askScopeNote') },
            {
              value: 'course',
              label: t('ai.askScopeCourse'),
              // Nothing to search: an inbox note belongs to no course.
              disabled: !note?.courseId,
              title: note?.courseId ? undefined : t('ai.askScopeCourseDisabled'),
            },
            { value: 'library', label: t('ai.askScopeLibrary') },
          ]}
        />
        {/* A switch, because the choice is one thing being on or off: may the
            model add what it knows, or is it held to the notes? It was a bare
            sparkle button, in a panel that already spent a sparkle on the empty
            state and another on the provider — three of the same mark for three
            different things, and the one carrying a decision was the one nobody
            could read. A two-segment control said it in words but ate the
            scope's label beside it; a switch says the same thing in the width
            the glyph had, and says it *as a state* rather than a picture. The
            sentence it stands for is in the tooltip and in the empty state. */}
        <button
          type="button"
          role="switch"
          aria-checked={knowledge}
          aria-label={`${t('ai.askMode')}: ${t(`ai.askMode${knowledge ? 'Knowledge' : 'Note'}`)}`}
          title={t(`ai.askIntro_${mode}`)}
          disabled={running}
          onClick={() => setAskMode(knowledge ? 'note' : 'knowledge')}
          className={cn(
            'ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-nb-xs px-1.5',
            'text-[11px] font-medium transition-colors duration-[var(--nb-t-fast)]',
            'disabled:pointer-events-none disabled:opacity-50',
            knowledge
              ? 'text-[var(--nb-accent)]'
              : 'text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text-2',
          )}
        >
          {t('ai.askModeSwitch')}
          <span
            aria-hidden
            className={cn(
              'relative h-[14px] w-6 rounded-full transition-colors duration-[var(--nb-t-fast)]',
              knowledge ? 'bg-[var(--nb-accent)]' : 'bg-[var(--nb-active)]',
            )}
          >
            <span
              className={cn(
                'absolute top-[2px] size-[10px] rounded-full bg-white shadow-sm',
                'transition-[left] duration-[var(--nb-t-fast)]',
                knowledge ? 'left-3' : 'left-[2px]',
              )}
            />
          </span>
        </button>
        {!empty && (
          <button
            type="button"
            aria-label={t('ai.clearThread')}
            title={t('ai.clearThread')}
            onClick={() => clearThread(noteId, key)}
            className="grid size-7 shrink-0 place-items-center rounded-nb-xs text-nb-text-3 transition-colors duration-[var(--nb-t-fast)] hover:bg-[var(--nb-hover)] hover:text-nb-text-2"
          >
            <Eraser size={13} aria-hidden />
          </button>
        )}
      </div>

      <div className="-mx-0.5 min-h-0 flex-1 space-y-2.5 overflow-y-auto px-0.5">
        {empty ? (
          <EmptyState
            mode={mode}
            scope={scope}
            disabled={!availability.available}
            onPick={applySuggestion}
          />
        ) : (
          thread.turns.map((turn, index) => (
            <Bubble
              key={index}
              role={turn.role}
              content={turn.content}
              sources={turn.sources}
              droppedCount={turn.droppedCount}
              onOpenSource={openSource}
              onSave={
                turn.role === 'assistant' && turn.content
                  ? () =>
                      void saveAnswer(
                        turn.content,
                        thread.turns[index - 1]?.content ?? t('ai.ask'),
                      )
                  : undefined
              }
            />
          ))
        )}

        {thread.streaming && <Bubble role="assistant" content={thread.streaming} />}
        {running && !thread.streaming && <Thinking scope={scope} />}
        {error && (
          <p
            role="alert"
            className="rounded-nb-xs bg-[color-mix(in_srgb,var(--nb-danger)_10%,transparent)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--nb-danger)]"
          >
            {error}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <div
        className={cn(
          'rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] p-1.5',
          'transition-colors duration-[var(--nb-t-fast)]',
          'focus-within:border-[var(--nb-accent)]',
          !availability.available && 'opacity-60',
        )}
      >
        <textarea
          ref={composerRef}
          rows={2}
          value={question}
          disabled={!availability.available}
          // Says the same thing whether or not a provider is configured. The
          // pill below is the one that reports "connect a provider", and it is
          // the one you can click to do it — two copies of that sentence in one
          // box is one copy too many.
          placeholder={t('ai.askPlaceholder')}
          aria-label={t('ai.ask')}
          // Enter-to-send is the contract every chat box already taught the
          // reader, so the reminder is a tooltip rather than a permanent line
          // in a 280px panel.
          title={t('ai.composerHint')}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift-Enter is a newline. The same contract as every
            // other chat box the student uses all day.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
          className="block w-full resize-none bg-transparent px-1 py-0.5 text-[12.5px] leading-relaxed outline-none placeholder:text-nb-text-3"
        />
        {/* Where the answer is about to go, next to the button that sends it.
            The pill used to head the panel, which is the one place its cost and
            trust argument does not apply — nothing is being sent up there. */}
        <div className="mt-1 flex items-center justify-end gap-1.5">
          <AiStatusPill feature="ask" modelOnly className="min-w-0" />
          <AiDisclosureButton />
          <GlassButton
            size="sm"
            variant={running ? 'default' : 'accent'}
            aria-label={running ? t('ai.cancel') : t('ai.send')}
            title={running ? t('ai.cancel') : t('ai.send')}
            disabled={!running && (!question.trim() || !availability.available)}
            onClick={() => (running ? cancelRun('ask') : void ask())}
            className="size-7 shrink-0 rounded-full px-0"
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Send size={12} />
            )}
          </GlassButton>
        </div>
      </div>
    </div>
  );
}

/**
 * What the panel says before the first question — which is most of the time a
 * student spends looking at it. The mode's own sentence lives here rather than
 * under the switch, so the explanation appears where there is room for it and
 * disappears once the thread makes it redundant.
 */
function EmptyState({
  mode,
  scope,
  disabled,
  onPick,
}: {
  mode: AskMode;
  scope: AskScope;
  disabled: boolean;
  onPick(question: string): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center px-1 pt-5 text-center">
      <span
        aria-hidden
        className="grid size-9 place-items-center rounded-full bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]"
      >
        <Sparkles size={16} />
      </span>
      <p className="mt-2.5 text-[13px] font-semibold">{t('ai.askEmptyTitle')}</p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-nb-text-3">
        {t(`ai.askIntro_${mode}`)}
      </p>
      {scope !== 'note' && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-nb-text-3">
          {t(`ai.askScopeHint_${scope}`)}
        </p>
      )}
      <div className="mt-3.5 flex w-full flex-col gap-1">
        {SUGGESTIONS.map((key) => {
          const suggestion = t(`ai.askSuggestion_${key}`);
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onPick(suggestion)}
              className={cn(
                'rounded-nb-xs border border-[var(--nb-divider)] px-2.5 py-1.5',
                'text-left text-[11.5px] text-nb-text-2',
                'transition-colors duration-[var(--nb-t-fast)]',
                'hover:border-[var(--nb-divider-strong)] hover:bg-[var(--nb-hover)] hover:text-nb-text',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              {suggestion}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Thinking({ scope }: { scope: AskScope }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-3 py-2.5"
    >
      <span aria-hidden className="flex gap-1">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="size-1.5 animate-pulse rounded-full bg-[var(--nb-text-3)] motion-reduce:animate-none"
            style={{ animationDelay: `${index * 160}ms` }}
          />
        ))}
      </span>
      <span className="text-[11.5px] text-nb-text-3">
        {t(scope === 'note' ? 'ai.askThinking' : 'ai.askSearching')}
      </span>
    </div>
  );
}

function Bubble({
  role,
  content,
  sources,
  droppedCount,
  onOpenSource,
  onSave,
}: {
  role: 'user' | 'assistant';
  content: string;
  sources?: AskTurn['sources'];
  droppedCount?: number;
  onOpenSource?(noteId: string): void;
  onSave?(): void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-nb-sm rounded-br-[4px] bg-[var(--nb-accent-soft)] px-2.5 py-2 text-[12.5px] leading-relaxed text-[var(--nb-accent)]">
          {content}
        </p>
      </div>
    );
  }

  const citations = sources && sources.length > 1 ? sources : undefined;

  return (
    <div className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-3 py-2.5">
      <AiRichText markdown={content} />

      {/* One footer for both — where the answer came from, and what you can do
          with it. They were two stacked rows, the citations always open, which
          in a 280px pane put more chrome under a short answer than the answer
          itself took. `items-start` keeps the actions on the disclosure's line
          when the citation list opens underneath it. */}
      {(citations || onSave) && (
        <div className="mt-2 flex items-start gap-1 border-t border-[var(--nb-divider)] pt-1.5">
          {citations ? (
            <Sources
              sources={citations}
              droppedCount={droppedCount ?? 0}
              onOpen={onOpenSource}
            />
          ) : (
            <span className="flex-1" />
          )}
          {onSave && (
            <>
              <BubbleAction
                icon={copied ? Check : Copy}
                label={copied ? t('common.copied') : t('common.copy')}
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(content)
                    .then(() => setCopied(true));
                }}
              />
              <BubbleAction
                icon={StickyNote}
                label={t('ai.saveAsNote')}
                onClick={onSave}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Which notes the answer was given.
 *
 * Built from what was *sent*, never from what the model wrote — so a row always
 * opens a note that really exists and really was in the prompt. Shown only when
 * there is more than the open note to report; a single-source answer has
 * nothing to disclose.
 *
 * Closed by default, and that is the point. The citation list answers "where
 * did this come from", which is a question you ask about *one* answer in ten;
 * open, it put a wrapped field of chips under every reply in a 280px pane. The
 * count is the part worth having on screen, because it is what tells you there
 * is anything to check.
 */
function Sources({
  sources,
  droppedCount,
  onOpen,
}: {
  sources: NonNullable<AskTurn['sources']>;
  droppedCount: number;
  onOpen?(noteId: string): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();

  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          // Same height as the action buttons beside it, so the two sit on one
          // baseline whether the list below is open or shut.
          'inline-flex h-6 max-w-full items-center gap-1 rounded-nb-xs pr-1.5',
          'text-[11px] text-nb-text-3',
          'transition-colors duration-[var(--nb-t-fast)]',
          'hover:text-nb-text-2 focus-visible:text-nb-text-2',
        )}
      >
        <ChevronRight
          size={11}
          aria-hidden
          className={cn(
            'shrink-0 transition-transform duration-[var(--nb-t-fast)]',
            open && 'rotate-90',
          )}
        />
        <span className="truncate">
          {t('ai.askSourcesCount', { count: sources.length })}
        </span>
      </button>

      {open && (
        <ul id={listId} className="mb-0.5 mt-0.5 flex flex-col gap-px">
          {sources.map((source) => (
            <li key={source.noteId}>
              <button
                type="button"
                onClick={() => onOpen?.(source.noteId)}
                title={source.truncated ? t('ai.askSourceTruncatedHint') : source.title}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-nb-xs px-1 py-1',
                  'text-left text-[11px] text-nb-text-2',
                  'transition-colors duration-[var(--nb-t-fast)]',
                  'hover:bg-[var(--nb-hover)] hover:text-nb-text',
                )}
              >
                <FileText size={11} aria-hidden className="shrink-0 text-nb-text-3" />
                <span className="truncate">{source.title}</span>
                {source.truncated && (
                  <span className="shrink-0 text-nb-text-3">
                    {t('ai.askSourceTruncated')}
                  </span>
                )}
                {/* Development only, and untranslated on purpose: this is the
                    readout that says whether a note the search should have found
                    ranked just below the cut or never surfaced at all. Tuning the
                    weights without it is guesswork. */}
                {import.meta.env.DEV && (
                  <span className="ml-auto shrink-0 font-mono text-nb-text-3">
                    {source.score.toFixed(2)}
                  </span>
                )}
              </button>
            </li>
          ))}
          {droppedCount > 0 && (
            <li className="px-1 pt-0.5 text-[10.5px] text-nb-text-3">
              {t('ai.askSourcesMore', { count: droppedCount })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Icon-only, because the label is the same two words under every answer in a
 * pane this narrow, and the tooltip says them for anyone who needs asking. */
function BubbleAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof StickyNote;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-nb-xs text-nb-text-3',
        'transition-colors duration-[var(--nb-t-fast)]',
        'hover:bg-[var(--nb-hover)] hover:text-nb-text focus-visible:text-nb-text',
      )}
    >
      <Icon size={12} aria-hidden />
    </button>
  );
}
