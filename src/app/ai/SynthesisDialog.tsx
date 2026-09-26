/**
 * Synthesis.
 *
 * Five output styles and a brief of the student's own, over the current note or
 * the whole multi-selection. The result is a new note, so there is no diff to
 * gate — the worst case is a note you delete, not an edit you have to unpick.
 */
import {
  AlignLeft,
  BookA,
  GraduationCap,
  ListTree,
  Loader2,
  MessageCircleQuestion,
  MessageSquareText,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChoiceGroup, Dialog, FieldNote, GlassButton } from '@/components/glass';
import { MAX_AI_SOURCES, type SynthesisStyle } from '@/lib/ai';
import { synthesizeNotesCommand } from '@/lib/commands';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { aiErrorMessage } from './aiErrorMessage';
import { Sources } from './Sources';
import { AiDialogStatus } from './AiDisclosure';
import { useAiAvailability } from './useAiAvailability';

/** Five shapes somebody guessed would be wanted, and the one that admits they
 * might want something else. `custom` sits last because it is the answer to
 * "none of these", which is a thing you conclude after reading the five. */
const STYLES: SynthesisStyle[] = [
  'summary',
  'revision',
  'outline',
  'qa',
  'glossary',
  'custom',
];

const STYLE_ICONS: Record<SynthesisStyle, LucideIcon> = {
  summary: AlignLeft,
  revision: GraduationCap,
  outline: ListTree,
  qa: MessageCircleQuestion,
  glossary: BookA,
  custom: MessageSquareText,
};

export function SynthesisDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.aiSynthesisOpen);
  const setOpen = useUiStore((state) => state.setAiSynthesisOpen);
  const selectNote = useUiStore((state) => state.selectNote);
  const multiSelection = useUiStore((state) => state.multiSelection);
  const selectedNoteId = useUiStore((state) => state.selectedNoteId);
  const notes = useLibraryStore((state) => state.notes);
  const running = useAiStore((state) => state.running) === 'synthesis';
  const availability = useAiAvailability('synthesis');

  const [style, setStyle] = useState<SynthesisStyle>('revision');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState('');
  const custom = style === 'custom';
  const briefed = !custom || instructions.trim().length > 0;
  const briefRef = useRef<HTMLTextAreaElement>(null);

  // Choosing "your own brief" is asking to write one. The dialog's own opening
  // focus belongs to the radio list, so this waits for the box to exist rather
  // than declaring `autoFocus`, which the modal's focus manager overrides.
  useEffect(() => {
    if (custom) briefRef.current?.focus();
  }, [custom]);

  const noteIds = multiSelection.length
    ? multiSelection
    : selectedNoteId
      ? [selectedNoteId]
      : [];

  // The count is knowable without loading a single document, so it is refused
  // here rather than after a round trip through the command layer. The token
  // budget is not — it needs the notes themselves — and comes back as a
  // `details.limit` the message below translates.
  const tooMany = noteIds.length > MAX_AI_SOURCES;

  async function run() {
    setError('');
    const signal = beginRun('synthesis');
    const result = await synthesizeNotesCommand(
      { noteIds, style, instructions: custom ? instructions.trim() : undefined },
      { signal },
    );
    endRun('synthesis', signal);

    if (!result.ok) {
      // A cancel is not a failure. The student pressed the button; telling
      // them so in red under the dialog reads as though something broke.
      if (result.code !== 'cancelled') setError(aiErrorMessage(result, t));
      return;
    }
    // Land the student in the note that was just made. A summary filed
    // somewhere they have to go and find is a summary they will not read.
    selectNote(result.value.id);
    await useEditorStore.getState().openNote(result.value.id);
    setOpen(false);
  }

  const titles = notes
    .filter((note) => noteIds.includes(note.id))
    .map((note) => note.title || t('noteList.untitled'));

  /** One close for the header's Escape, the Cancel button, and the status
   * pill on its way to Settings — a dialog left open behind that window is
   * a window you cannot reach. */
  function close() {
    cancelRun('synthesis');
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('ai.synthesis')}
      description={t('ai.synthesisIntro')}
      size="lg"
      headerAction={<AiDialogStatus feature="synthesis" onLeave={close} />}
      footer={
        <>
          {running ? (
            <GlassButton size="sm" onClick={() => cancelRun('synthesis')}>
              {t('ai.cancel')}
            </GlassButton>
          ) : (
            <GlassButton size="sm" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </GlassButton>
          )}
          <GlassButton
            size="sm"
            variant="accent"
            disabled={
              !noteIds.length || tooMany || !availability.available || !briefed || running
            }
            onClick={() => void run()}
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} aria-hidden />
            )}
            {running ? t('ai.running') : t('ai.createNote')}
          </GlassButton>
        </>
      }
    >
      <Sources count={noteIds.length} titles={titles} />

      <ChoiceGroup<SynthesisStyle>
        label={t('ai.synthesisStyle')}
        value={style}
        onChange={setStyle}
        disabled={running}
        options={STYLES.map((entry) => ({
          value: entry,
          icon: STYLE_ICONS[entry],
          title: t(`ai.style_${entry}`),
          description: t(`ai.styleHint_${entry}`),
        }))}
      />

      {/* Under the option it belongs to, and only then: a text box that does
          nothing until a radio above it is chosen is a box people type into
          and then wonder why it was ignored. */}
      {custom && (
        <textarea
          ref={briefRef}
          rows={3}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={t('ai.styleCustomPlaceholder')}
          aria-label={t('ai.style_custom')}
          className={cn(
            'mt-1.5 block w-full resize-y rounded-nb-sm px-2.5 py-2',
            'border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)]',
            'text-[12.5px] leading-relaxed outline-none placeholder:text-nb-text-3',
            'transition-colors duration-[var(--nb-t-fast)] focus:border-[var(--nb-accent)]',
          )}
        />
      )}

      {tooMany && (
        <FieldNote tone="danger">
          {t('ai.limit_too_many_notes', { max: MAX_AI_SOURCES })}
        </FieldNote>
      )}
      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
