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
import { Eraser, Loader2, Send, StickyNote } from 'lucide-react';
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

  // Follow the stream. A panel that makes you scroll to watch an answer arrive
  // is a panel you stop watching.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.turns.length, thread.streaming]);

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
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <AiStatusPill feature="ask" className="min-w-0" />
        {thread.turns.length > 0 && (
          <button
            type="button"
            aria-label={t('ai.clearThread')}
            title={t('ai.clearThread')}
            onClick={() => clearThread(noteId, mode)}
            className="ml-auto rounded-nb-xs p-1 text-nb-text-3 hover:bg-[var(--nb-hover)]"
          >
            <Eraser size={12} />
          </button>
        )}
      </div>

      <GlassSegmentedControl<AskMode>
        label={t('ai.askMode')}
        value={mode}
        onChange={setAskMode}
        disabled={running}
        options={[
          { value: 'note', label: t('ai.askModeNote') },
          { value: 'knowledge', label: t('ai.askModeKnowledge') },
        ]}
      />

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {!thread.turns.length && !thread.streaming && (
          <p className="text-[12px] text-nb-text-3">{t(`ai.askIntro_${mode}`)}</p>
        )}

        {thread.turns.map((turn, index) => (
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
        ))}

        {thread.streaming && <Bubble role="assistant" content={thread.streaming} />}
        {error && <p className="text-[12px] text-[var(--nb-danger)]">{error}</p>}
        <div ref={endRef} />
      </div>

      <div className="flex items-end gap-1">
        <textarea
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
          className="min-w-0 flex-1 resize-none rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] p-2 text-[12px] disabled:opacity-50"
        />
        <GlassButton
          size="sm"
          variant={running ? 'default' : 'accent'}
          aria-label={running ? t('ai.cancel') : t('ai.send')}
          disabled={!running && (!question.trim() || !availability.available)}
          onClick={() => (running ? cancelRun('ask') : void ask())}
        >
          {running ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
        </GlassButton>
      </div>
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
  return (
    <div
      className={cn(
        'group rounded-nb-sm',
        role === 'user'
          ? 'ml-5 bg-[var(--nb-accent-soft)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--nb-accent)]'
          : 'border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-3 py-3 text-nb-text',
      )}
    >
      {role === 'assistant' ? (
        <AiRichText markdown={content} />
      ) : (
        <p className="whitespace-pre-wrap break-words">{content}</p>
      )}
      {onSave && (
        <button
          type="button"
          onClick={onSave}
          className="mt-2 inline-flex items-center gap-1 border-t border-[var(--nb-divider)] pt-2 text-[11px] text-nb-text-3 transition-colors hover:text-nb-text focus:text-nb-text"
        >
          <StickyNote size={10} />
          {t('ai.saveAsNote')}
        </button>
      )}
    </div>
  );
}
