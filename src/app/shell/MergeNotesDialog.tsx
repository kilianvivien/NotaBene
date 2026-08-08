/**
 * Merging a selection into one note.
 *
 * The dialog exists mainly to answer one question — what happens to the notes
 * it consumes — and to show the order before it is committed to. Merging is
 * not undoable as a single act: the sources can be pulled back out of the
 * trash, but nobody is going to reconstruct which paragraph came from which
 * lecture by hand, so the order is on screen before the button is pressed.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  FieldNote,
  FieldRow,
  GlassButton,
  GlassIconButton,
  GlassSelect,
} from '@/components/glass';
import { mergeNotesCommand, mergeOrder, type MergeSourceFate } from '@/lib/commands';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';

export function MergeNotesDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.mergeOpen);
  const setOpen = useUiStore((state) => state.setMergeOpen);
  const selection = useUiStore((state) => state.multiSelection);
  const notes = useLibraryStore((state) => state.notes);
  const savedFate = useSettingsStore((state) => state.settings.mergeSourceFate);
  const updateSettings = useSettingsStore((state) => state.update);

  const [title, setTitle] = useState('');
  const [fate, setFate] = useState<MergeSourceFate>(savedFate);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  /** The running order, seeded from `mergeOrder` and then the student's to
   * arrange. Held as ids so a background refresh of the note list cannot
   * silently reshuffle a sequence they have already set. */
  const [order, setOrder] = useState<string[]>([]);

  // Reopening with a different selection must not carry the last run's title
  // or arrangement over — a merge called "Lecture 4" containing lectures 7 to
  // 9 is worse than an untitled one.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setFate(savedFate);
    setError('');
    setOrder(
      mergeOrder(notes.filter((note) => selection.includes(note.id))).map(
        (note) => note.id,
      ),
    );
    // Seeded once per opening. Depending on `notes` would rebuild the order
    // every time the list refreshes underneath the dialog, throwing away the
    // arrangement the student was in the middle of making.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ordered = order
    .map((noteId) => notes.find((note) => note.id === noteId))
    .filter((note): note is (typeof notes)[number] => note !== undefined);

  /** Move one note a single place. Buttons rather than dragging: ten rows in a
   * modal is a list you nudge, and an up/down pair is reachable from the
   * keyboard, which a drag is not. */
  function move(index: number, delta: number) {
    setOrder((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function run() {
    setWorking(true);
    setError('');
    const result = await mergeNotesCommand({
      noteIds: ordered.map((note) => note.id),
      title: title.trim() || undefined,
      sourceFate: fate,
    });
    setWorking(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (fate !== savedFate) await updateSettings({ mergeSourceFate: fate });
    setOpen(false);
  }

  const placeholder = ordered[0]?.title || t('noteList.untitled');

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('merge.title')}
      size="md"
      footer={
        <>
          <GlassButton size="sm" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="accent"
            disabled={ordered.length < 2 || working}
            onClick={() => void run()}
          >
            {working ? t('merge.merging') : t('merge.action')}
          </GlassButton>
        </>
      }
    >
      <FieldRow label={t('merge.noteTitle')}>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={placeholder}
          aria-label={t('merge.noteTitle')}
          className={cn(
            'block w-full rounded-nb-sm px-2.5 py-1.5',
            'border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)]',
            'text-[12.5px] outline-none placeholder:text-nb-text-3',
            'transition-colors duration-[var(--nb-t-fast)] focus:border-[var(--nb-accent)]',
          )}
        />
      </FieldRow>

      {/* Full width rather than in a `FieldRow`'s control column: the point of
          the list is that the titles are readable while they are being
          arranged, and twelve of them truncated to 280px would be a list of
          "Cours de d…". */}
      <div className="py-2">
        <span className="block text-[13px] leading-snug">{t('merge.sources')}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-nb-text-3">
          {t('merge.sourcesHint')}
        </span>
        <ol className="mt-1.5 max-h-56 overflow-y-auto rounded-nb-sm border border-[var(--nb-divider)]">
          {ordered.map((note, index) => (
            <li
              key={note.id}
              className={cn(
                'flex min-w-0 items-center gap-1.5 py-0.5 pl-2 pr-1',
                index > 0 && 'border-t border-[var(--nb-divider)]',
              )}
            >
              <span className="w-4 shrink-0 tabular-nums text-[12px] text-nb-text-3">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                {note.title || t('noteList.untitled')}
              </span>
              <GlassIconButton
                label={t('merge.moveUp', { title: note.title || t('noteList.untitled') })}
                className="size-6"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ChevronUp size={13} />
              </GlassIconButton>
              <GlassIconButton
                label={t('merge.moveDown', {
                  title: note.title || t('noteList.untitled'),
                })}
                className="size-6"
                disabled={index === ordered.length - 1}
                onClick={() => move(index, 1)}
              >
                <ChevronDown size={13} />
              </GlassIconButton>
            </li>
          ))}
        </ol>
      </div>

      <FieldRow label={t('merge.originals')} hint={t(`merge.fateHint_${fate}`)}>
        <GlassSelect
          label={t('merge.originals')}
          value={fate}
          onChange={(event) => setFate(event.target.value as MergeSourceFate)}
        >
          <option value="trash">{t('merge.fate_trash')}</option>
          <option value="archive">{t('merge.fate_archive')}</option>
          <option value="keep">{t('merge.fate_keep')}</option>
        </GlassSelect>
      </FieldRow>

      {/* The File menu can raise this sheet with nothing selected — it has no
          way to report a refusal — so the dialog is where "merging needs two
          notes" gets said. */}
      <FieldNote>
        {ordered.length < 2
          ? t('merge.needTwo')
          : t('merge.count', { count: ordered.length })}
      </FieldNote>
      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
