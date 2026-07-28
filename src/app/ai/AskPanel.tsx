/**
 * Ask a question about the open note.
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
import { Check, Copy, Eraser, Loader2, Send, Sparkles, StickyNote } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, GlassSegmentedControl } from '@/components/glass';
import type { AskMode } from '@/lib/ai';
import { askAboutNotesCommand, saveAnswerAsNoteCommand } from '@/lib/commands';
import {
  beginRun,
  cancelRun,
  endRun,
  EMPTY_THREAD,
  useAiStore,
} from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { AiStatusPill } from './AiStatusPill';
import { AiRichText } from './AiRichText';
import { useAiAvailability } from './useAiAvailability';

const SUGGESTIONS = ['summary', 'explain', 'quiz'] as const;

/** Enough for four or five lines; past that the thread matters more. */
const COMPOSER_MAX_HEIGHT = 108;

export function AskPanel({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const mode = useAiStore((state) => state.askMode);
  const thread =
    useAiStore((state) => state.threads[noteId]?.[state.askMode]) ?? EMPTY_THREAD;
  const running = useAiStore((state) => state.running) === 'ask';
  const clearThread = useAiStore((state) => state.clearThread);
  const setAskMode = useAiStore((state) => state.setAskMode);
  const selectNote = useUiStore((state) => state.selectNote);
  const availability = useAiAvailability('ask');

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
    const requestMode = mode;
    const store = useAiStore.getState();
    store.commitTurn(noteId, requestMode, { role: 'user', content: asked });

    const signal = beginRun('ask');
    const result = await askAboutNotesCommand(
      {
        noteIds: [noteId],
        mode: requestMode,
        question: asked,
        history: thread.turns,
      },
      {
        signal,
        onToken: (token) => useAiStore.getState().appendToken(noteId, requestMode, token),
      },
    );
    endRun('ask');

    if (result.ok) {
      store.commitTurn(noteId, requestMode, {
        role: 'assistant',
        content: result.value,
      });
      return;
    }

    // A cancelled answer keeps whatever streamed in — the student asked to
    // stop, not to throw away the half they had already read.
    const partial = useAiStore.getState().threads[noteId]?.[requestMode]?.streaming ?? '';
    if (partial) {
      store.commitTurn(noteId, requestMode, {
        role: 'assistant',
        content: partial,
      });
    } else {
      store.discardStreaming(noteId, requestMode);
    }
    setError(
      result.code === 'not_supported' ? t('ai.notConfiguredHint') : result.message,
    );
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
      <div className="flex items-center gap-1.5">
        <AiStatusPill feature="ask" className="min-w-0" />
        {!empty && (
          <button
            type="button"
            aria-label={t('ai.clearThread')}
            title={t('ai.clearThread')}
            onClick={() => clearThread(noteId, mode)}
            className="ml-auto shrink-0 rounded-nb-xs p-1.5 text-nb-text-3 transition-colors duration-[var(--nb-t-fast)] hover:bg-[var(--nb-hover)] hover:text-nb-text-2"
          >
            <Eraser size={13} />
          </button>
        )}
      </div>

      <GlassSegmentedControl<AskMode>
        label={t('ai.askMode')}
        value={mode}
        onChange={setAskMode}
        disabled={running}
        fill
        options={[
          { value: 'note', label: t('ai.askModeNote') },
          { value: 'knowledge', label: t('ai.askModeKnowledge') },
        ]}
      />

      <div className="-mx-0.5 min-h-0 flex-1 space-y-2.5 overflow-y-auto px-0.5">
        {empty ? (
          <EmptyState
            mode={mode}
            disabled={!availability.available}
            onPick={applySuggestion}
          />
        ) : (
          thread.turns.map((turn, index) => (
            <Bubble
              key={index}
              role={turn.role}
              content={turn.content}
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
        {running && !thread.streaming && <Thinking />}
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
          placeholder={
            availability.available ? t('ai.askPlaceholder') : t('ai.notConfigured')
          }
          aria-label={t('ai.ask')}
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
        <div className="mt-1 flex items-end justify-between gap-2 pl-1">
          <span className="min-w-0 truncate text-[10.5px] text-nb-text-3">
            {t('ai.composerHint')}
          </span>
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
  disabled,
  onPick,
}: {
  mode: AskMode;
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

function Thinking() {
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
      <span className="text-[11.5px] text-nb-text-3">{t('ai.askThinking')}</span>
    </div>
  );
}

function Bubble({
  role,
  content,
  onSave,
}: {
  role: 'user' | 'assistant';
  content: string;
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

  return (
    <div className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-3 py-2.5">
      <AiRichText markdown={content} />
      {onSave && (
        <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-[var(--nb-divider)] pt-1.5">
          <BubbleAction icon={StickyNote} label={t('ai.saveAsNote')} onClick={onSave} />
          <BubbleAction
            icon={copied ? Check : Copy}
            label={copied ? t('common.copied') : t('common.copy')}
            onClick={() => {
              void navigator.clipboard?.writeText(content).then(() => setCopied(true));
            }}
          />
        </div>
      )}
    </div>
  );
}

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
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-nb-xs px-1.5 py-1',
        'whitespace-nowrap text-[11px] text-nb-text-3',
        'transition-colors duration-[var(--nb-t-fast)]',
        'hover:bg-[var(--nb-hover)] hover:text-nb-text focus-visible:text-nb-text',
      )}
    >
      <Icon size={11} aria-hidden className="shrink-0" />
      {label}
    </button>
  );
}
