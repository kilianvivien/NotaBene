/**
 * Synthesis.
 *
 * Four output styles and a brief of the student's own, over the current note or
 * the whole multi-selection. The result is a new note, so there is no diff to
 * gate — the worst case is a note you delete, not an edit you have to unpick.
 */
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, FieldNote, GlassButton } from '@/components/glass';
import type { SynthesisStyle } from '@/lib/ai';
import { synthesizeNotesCommand } from '@/lib/commands';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { AiDialogStatus } from './AiDisclosure';
import { useAiAvailability } from './useAiAvailability';

/** Four shapes somebody guessed would be wanted, and the one that admits they
 * might want something else. `custom` sits last because it is the answer to
 * "none of these", which is a thing you conclude after reading the four. */
const STYLES: SynthesisStyle[] = ['summary', 'revision', 'qa', 'glossary', 'custom'];

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

  async function run() {
    setError('');
    const signal = beginRun('synthesis');
    const result = await synthesizeNotesCommand(
      { noteIds, style, instructions: custom ? instructions.trim() : undefined },
      { signal },
    );
    endRun('synthesis');

    if (!result.ok) {
      setError(
        result.code === 'not_supported' ? t('ai.notConfiguredHint') : result.message,
      );
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
      size="md"
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
            disabled={!noteIds.length || !availability.available || !briefed || running}
            onClick={() => void run()}
          >
            {running && <Loader2 size={12} className="animate-spin" />}
            {running ? t('ai.running') : t('ai.createNote')}
          </GlassButton>
        </>
      }
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-nb-text-3">
          {t('ai.synthesisStyle')}
        </legend>
        {STYLES.map((entry) => (
          <label
            key={entry}
            className="flex cursor-pointer items-start gap-2 rounded-nb-xs p-1.5 hover:bg-[var(--nb-hover)]"
          >
            <input
              type="radio"
              name="nb-synthesis-style"
              checked={style === entry}
              onChange={() => setStyle(entry)}
              className="mt-0.5 shrink-0 accent-[var(--nb-accent)]"
            />
            <span className="min-w-0">
              <span className="block text-[13px]">{t(`ai.style_${entry}`)}</span>
              <span className="block text-[11px] text-nb-text-3">
                {t(`ai.styleHint_${entry}`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

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

      <FieldNote>
        {t('ai.sourceCount', { count: noteIds.length })}
        {titles.length > 0 && (
          <span className="block truncate">{titles.join(' · ')}</span>
        )}
      </FieldNote>
      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
